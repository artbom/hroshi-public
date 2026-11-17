import { describe, expect, it } from 'vitest';

import { describeUserTurn, findClaudeAnswer } from './stream.ts';

describe('describeUserTurn', () => {
  it('puts the pictures before the words, one JSON line', () => {
    const line = describeUserTurn({ text: 'внеси', images: [{ mediaType: 'image/jpeg', data: Buffer.from('jpeg') }] });
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from('jpeg').toString('base64') } },
          { type: 'text', text: 'внеси' },
        ],
      },
    });
  });
});

describe('findClaudeAnswer', () => {
  it('takes the result event out of the stream', () => {
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'assistant', message: {} }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'Готово.', session_id: 's1', is_error: false }),
      '',
    ].join('\n');
    expect(findClaudeAnswer(stdout)).toEqual({ result: 'Готово.', session_id: 's1', is_error: false });
  });

  it('finds nothing when Claude failed before starting', () => {
    expect(findClaudeAnswer('Invalid API key · Please run /login')).toBeUndefined();
  });
});
