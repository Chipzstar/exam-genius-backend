import { prisma } from '../../utils/prisma';

function summarizeQuestions(questions: { label: string | null; marks: number; body: unknown }[]): string {
	return questions
		.map(q => {
			const body = JSON.stringify(q.body).slice(0, 500);
			return `[${q.label ?? '?'}] (${q.marks}m) ${body}`;
		})
		.join('\n');
}

export async function buildStudentStyleContext(params: {
	userId: string;
	courseId: string;
	paperCode: string;
}): Promise<{ exemplars: string; avoid: string }> {
	const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

	const papers = await prisma.paper.findMany({
		where: {
			user_id: params.userId,
			course_id: params.courseId,
			paper_code: params.paperCode,
			status: 'success',
			structured_at: { not: null },
			updated_at: { gte: thirtyDaysAgo }
		},
		include: {
			paperRating: true,
			questions: { orderBy: [{ order: 'asc' }], take: 12 }
		},
		orderBy: { updated_at: 'desc' },
		take: 10
	});

	const liked = papers
		.filter(p => p.paperRating && p.paperRating.stars >= 4)
		.slice(0, 2)
		.map(p => summarizeQuestions(p.questions))
		.join('\n---\n');

	const feedback = await prisma.questionFeedback.findMany({
		where: {
			user_id: params.userId,
			sentiment: { lt: 0 },
			question: {
				paper: {
					course_id: params.courseId,
					paper_code: params.paperCode
				}
			}
		},
		orderBy: { created_at: 'desc' },
		take: 10
	});

	const tagCounts = new Map<string, number>();
	for (const f of feedback) {
		for (const t of f.reason_tags) {
			tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
		}
	}

	const topTags = [...tagCounts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5)
		.map(([t, n]) => `${t} (${n})`)
		.join(', ');

	let avoid = '';
	if (topTags) {
		avoid = `Recent negative feedback themes: ${topTags}. Address these in wording, difficulty, and alignment to the specification.`;
	}

	return { exemplars: liked, avoid };
}
