import { describe, expect, it } from 'vitest';
import { buildFigureRasterPrompt, truncateFigureElementsJson } from './figure-render';

describe('truncateFigureElementsJson', () => {
	it('returns full JSON when under the limit', () => {
		const elements = { a: 1, b: 'two' };
		const { json, truncated } = truncateFigureElementsJson(elements);
		expect(truncated).toBe(false);
		expect(JSON.parse(json)).toEqual(elements);
	});

	it('drops trailing keys until JSON fits and stays parseable', () => {
		const elements: Record<string, unknown> = {};
		for (let i = 0; i < 80; i++) {
			elements[`part_${i}`] = `label-${'x'.repeat(120)}`;
		}
		const { json, truncated } = truncateFigureElementsJson(elements, 6000);
		expect(truncated).toBe(true);
		expect(json.length).toBeLessThanOrEqual(6000);
		expect(() => JSON.parse(json)).not.toThrow();
		const parsed = JSON.parse(json) as Record<string, unknown>;
		expect(Object.keys(parsed).length).toBeGreaterThan(0);
		expect(Object.keys(parsed).length).toBeLessThan(80);
	});

	it('never returns malformed JSON from byte slicing', () => {
		const elements: Record<string, unknown> = { huge: 'z'.repeat(8000) };
		const { json } = truncateFigureElementsJson(elements, 6000);
		expect(() => JSON.parse(json)).not.toThrow();
	});
});

describe('buildFigureRasterPrompt', () => {
	it('appends truncation marker when elements were reduced', () => {
		const elements: Record<string, unknown> = {};
		for (let i = 0; i < 60; i++) {
			elements[`k${i}`] = 'value-' + 'y'.repeat(100);
		}
		const prompt = buildFigureRasterPrompt({
			subject: 'Physics',
			diagram_type: 'circuit',
			caption: 'Test',
			elements
		});
		expect(prompt).toContain('...[TRUNCATED]');
		const jsonSection = prompt.split('JSON:\n')[1]?.split('\nNo handwriting')[0] ?? '';
		const jsonOnly = jsonSection.replace(/\n\.\.\.\[TRUNCATED\]$/, '');
		expect(() => JSON.parse(jsonOnly)).not.toThrow();
	});
});
