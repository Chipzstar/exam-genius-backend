import { FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'crypto';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { prisma } from '../../utils/prisma';
import { logger } from '../../utils/logger';
import { logAiStructured } from '../../utils/ai-structured-log';

type ExtractBody = {
	reference_id: string;
	user_id: string;
	course_id: string;
	paper_code?: string | null;
	kind: 'question_paper' | 'mark_scheme' | 'examiner_report';
	ut_key: string;
	ut_url: string;
	filename: string;
};

export async function extractReference(req: FastifyRequest, reply: FastifyReply): Promise<void> {
	const t0 = Date.now();
	try {
		const body = req.body as ExtractBody;
		const {
			reference_id,
			user_id,
			course_id,
			paper_code,
			kind,
			ut_key,
			ut_url,
			filename
		} = body;

		const existing = await prisma.paperReference.findFirst({
			where: { user_id, reference_id }
		});
		if (existing?.status === 'ready') {
			logAiStructured('reference_extract', {
				reference_id,
				duration_ms: Date.now() - t0,
				ok: true,
				deduped: true
			});
			return reply.code(200).send({ ok: true, deduped: true });
		}

		await prisma.paperReference.upsert({
			where: { reference_id },
			create: {
				reference_id,
				user_id,
				course_id,
				paper_code: paper_code ?? null,
				kind,
				ut_key,
				ut_url,
				filename,
				extracted_text: '',
				text_hash: '',
				status: 'processing'
			},
			update: {
				status: 'processing',
				ut_key,
				ut_url,
				filename
			}
		});

		const res = await fetch(ut_url);
		if (!res.ok) throw new Error(`Download failed ${res.status}`);
		const buf = Buffer.from(await res.arrayBuffer());

		let text = '';
		try {
			const parsed = await pdfParse(buf);
			text = parsed.text ?? '';
		} catch (e) {
			logger.warn('pdf-parse failed', { error: String(e) });
		}

		if (text.trim().length < 500) {
			await prisma.paperReference.update({
				where: { reference_id },
				data: {
					status: 'failed',
					extracted_text: text,
					text_hash: '',
					token_count: 0
				}
			});
			logAiStructured('reference_extract', {
				reference_id,
				duration_ms: Date.now() - t0,
				ok: false,
				error: 'insufficient_text'
			});
			return reply.code(422).send({ error: 'Could not extract enough text from PDF (try a text-based PDF)' });
		}

		const hash = createHash('sha256').update(text).digest('hex');
		const dup = await prisma.paperReference.findFirst({
			where: { user_id, text_hash: hash, status: 'ready' }
		});
		if (dup && dup.reference_id !== reference_id) {
			await prisma.paperReference.update({
				where: { reference_id },
				data: {
					status: 'ready',
					extracted_text: dup.extracted_text,
					text_hash: hash,
					token_count: Math.ceil(dup.extracted_text.length / 4)
				}
			});
			logAiStructured('reference_extract', {
				reference_id,
				duration_ms: Date.now() - t0,
				ok: true,
				deduped: true
			});
			return reply.code(200).send({ ok: true, deduped: true });
		}

		await prisma.paperReference.update({
			where: { reference_id },
			data: {
				status: 'ready',
				extracted_text: text,
				text_hash: hash,
				token_count: Math.ceil(text.length / 4)
			}
		});

		logAiStructured('reference_extract', {
			reference_id,
			duration_ms: Date.now() - t0,
			ok: true
		});

		return reply.code(200).send({ ok: true });
	} catch (error: unknown) {
		const err = error as { message?: string };
		logger.error('extractReference', { error: String(err) });
		try {
			const body = req.body as ExtractBody;
			logAiStructured('reference_extract', {
				reference_id: body?.reference_id ?? 'unknown',
				duration_ms: Date.now() - t0,
				ok: false,
				error: String(err)
			});
			if (body?.reference_id) {
				await prisma.paperReference.updateMany({
					where: { reference_id: body.reference_id },
					data: { status: 'failed' }
				});
			}
		} catch {
			/* ignore */
		}
		return reply.code(500).send({ error: 'Extract failed', message: err.message });
	}
}
