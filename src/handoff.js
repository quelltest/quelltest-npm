const GUIDANCE = {
  operator: (m) => `Add an assertion on both sides of this operator so the test fails when \`${m.description.split(' (')[0]}\` is applied (test the boundary value and its neighbours).`,
  guard: () => 'The guard can be removed without any test failing. Add a case that violates the guard and assert the rejection (error type and message, or the returned value).',
  throw: () => 'The `throw` can be removed without any test failing. Assert that the thrown error is raised for the invalid input (`assert.throws` / `expect(...).toThrow`).',
  await: () => 'Dropping `await` goes unnoticed. Assert on the effect that must have completed (the written value, the rejected promise, the awaited result) rather than only that the call returned.',
  nullish: () => 'Falling back with `||` instead of `??` (or the reverse) goes unnoticed. Add a case with `0`, `""` or `false` and assert the value is preserved or replaced as intended.',
  sanitizer: () => 'Removing the sanitiser goes unnoticed. Add a hostile input (regex metacharacters, `../`, `{ "$ne": null }`, non-string) and assert it is neutralised or rejected.',
};

/**
 * Render the survivors of a verification result as Markdown an agent (or a person) can act on:
 * for each surviving mutant, the location, the change, the source context and a specific instruction.
 */
export function renderHandoff(result, { sourceText = '' } = {}) {
  const survivors = (result.mutants ?? []).filter((mutant) => mutant.outcome === 'survived');
  const lines = sourceText.split('\n');
  const out = ['# Quelltest handoff: mutants your tests did not catch', ''];
  out.push(`- Source: \`${result.sourceFile ?? 'unknown'}\``, `- Test: \`${result.testPath ?? 'unknown'}\``);
  out.push(`- Result: ${result.verified ? 'verified' : 'NOT verified'} — ${result.killed ?? 0}/${result.total ?? 0} mutants killed${result.mutationScore == null ? '' : ` (${result.mutationScore}%)`}${result.reason ? `; ${result.reason}` : ''}`);
  if (result.inconclusive) out.push(`- Inconclusive: ${result.inconclusive} mutant(s) timed out or could not run (not counted as kills)`);
  if (result.ignored) out.push(`- Ignored by \`quell-ignore-mutant\`: ${result.ignored}`);
  const mockedSurvivors = survivors.filter((mutant) => mutant.mockBoundary);
  if (mockedSurvivors.length) out.push(`- On mocked code: ${mockedSurvivors.length} of ${survivors.length} survivors touch ${[...new Set(mockedSurvivors.map((mutant) => `\`${mutant.mockBoundary}\``))].join(', ')}, which the test replaces with a double`);
  out.push('');
  if (!survivors.length) {
    out.push('No surviving mutants.');
    return `${out.join('\n')}\n`;
  }
  out.push(`${survivors.length} surviving mutant(s). For each, add or strengthen an assertion in the test, then re-run \`quell verify\`.`, '');
  survivors.forEach((mutant, index) => {
    out.push(`## ${index + 1}. ${mutant.description} in \`${mutant.function}\``, '');
    out.push('```diff', `- ${mutant.before}`, `+ ${mutant.after}`, '```', '');
    const from = Math.max(0, mutant.line - 3);
    const context = lines.slice(from, mutant.line + 2);
    if (context.length) out.push('Context:', '', '```js', ...context.map((text, offset) => `${String(from + offset + 1).padStart(4)}  ${text}`), '```', '');
    out.push(`**What to do:** ${(GUIDANCE[mutant.kind] ?? GUIDANCE.operator)(mutant)}`, '');
    if (mutant.mockBoundary) out.push(`**Mock boundary:** this test mocks \`${mutant.mockBoundary}\`, so this change may only be observable against the real dependency. Either assert the interaction (the mock was called with the right arguments, in order) or add a real-dependency test (Testcontainers, an in-memory server) and run \`quell verify --command\`. See docs/dependencies.md.`, '');
  });
  out.push('If a survivor is an equivalent mutant (the change cannot alter behaviour), mark the line with `// quell-ignore-mutant <reason>` instead of contorting the test.');
  return `${out.join('\n')}\n`;
}
