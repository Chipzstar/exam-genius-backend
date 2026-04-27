import type { ContentBlock, PaperGenerationResult } from './schema';

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

export function renderBlockToHtml(block: ContentBlock): string {
	switch (block.kind) {
		case 'text':
			return block.value;
		case 'math':
			return `<p class="eg-math">${escapeHtml(block.value)}</p>`;
		case 'image_placeholder':
			return `<p class="eg-figure"><em>[Figure: ${escapeHtml(block.caption)}]</em></p>`;
		case 'table': {
			const head = block.headers.map(h => `<th>${escapeHtml(h)}</th>`).join('');
			const body = block.rows
				.map(row => `<tr>${row.map(c => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`)
				.join('');
			return `<table class="eg-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
		}
		default:
			return '';
	}
}

type QNode = PaperGenerationResult['questions'][number] & {
	db_id: string;
	children: QNode[];
};

function buildTree(flat: PaperGenerationResult['questions']): QNode[] {
	const byClient = new Map<string, QNode>();
	for (const q of flat) {
		byClient.set(q.client_id, { ...q, db_id: '', children: [] });
	}
	const roots: QNode[] = [];
	for (const q of flat) {
		const node = byClient.get(q.client_id)!;
		if (q.parent_client_id && byClient.has(q.parent_client_id)) {
			byClient.get(q.parent_client_id)!.children.push(node);
		} else {
			roots.push(node);
		}
	}
	const sortRec = (nodes: QNode[]) => {
		nodes.sort((a, b) => a.order - b.order);
		for (const n of nodes) sortRec(n.children);
	};
	sortRec(roots);
	return roots;
}

function renderQuestionNodeHtml(node: QNode): string {
	const bodyHtml = node.body.map(renderBlockToHtml).join('');
	const marks = node.marks > 0 ? ` <strong>[${node.marks} mark${node.marks === 1 ? '' : 's'}]</strong>` : '';
	if (node.children.length === 0) {
		const label = node.label ? `${escapeHtml(node.label)}. ` : '';
		return `<li>${label}${bodyHtml}${marks}</li>`;
	}
	const label = node.label ? `${escapeHtml(node.label)}. ` : '';
	const inner = node.children.map(renderQuestionNodeHtml).join('');
	return `<li>${label}${bodyHtml}${marks}<ol type="a">${inner}</ol></li>`;
}

export function renderPaperHtml(result: PaperGenerationResult): string {
	const meta = result.paper_meta;
	let header = '';
	if (meta?.time_allowed_minutes != null || meta?.total_marks != null) {
		const parts: string[] = [];
		if (meta.time_allowed_minutes != null) parts.push(`Time allowed: ${meta.time_allowed_minutes} minutes`);
		if (meta.total_marks != null) parts.push(`Total marks: ${meta.total_marks}`);
		header = `<p>${parts.join(' — ')}</p>`;
	}
	if (meta?.preamble_html) {
		header += meta.preamble_html;
	}
	header += '<hr />';
	const roots = buildTree(result.questions);
	const list = roots.map(renderQuestionNodeHtml).join('');
	return `${header}<ol type="1">${list}</ol>`;
}
