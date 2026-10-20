export interface Finding { id: string; file: string; line: number; column: number; endLine: number; function: string; rule?: string; risk: number; confidence: 'low' | 'medium' | 'high'; category: string; evidence: string; suggestion: string; status?: 'WRITTEN' | 'SCAFFOLDED' | 'FLAGGED'; verified?: boolean; covered?: boolean; branch?: boolean; endColumn?: number }
export interface Summary { score: number | null; tier: 'production-ready' | 'review-needed' | 'edge-cases-uncovered' | 'not-scored' | 'no-findings'; total: number; covered: number | null; uncovered: number | null; coverageEvidence: 'none' | 'istanbul' | 'lcov'; evidenceFile: string | null }
export interface Report { version: 1; root: string; findings: Finding[]; summary?: Summary }
export interface ScanOptions { include?: string[]; exclude?: string[]; includeTests?: boolean; coverage?: string | false; diff?: string; minConfidence?: 'low' | 'medium' | 'high' }
export declare function scan(root?: string, options?: ScanOptions): { version: 1; root: string; findings: Finding[]; skipped: string[] };
export declare function score(report: { findings: Finding[] }, evidence?: { kind: string; source?: string }): Summary;
export declare function toSarif(report: { findings: Finding[] }, version?: string): object;
export declare function report(root?: string, options?: ScanOptions): Report;
export type GenerateStatus = 'GENERATED' | 'VERIFIED' | 'TODO' | 'FLAGGED' | 'SKIPPED';
export interface GenerateOptions { destination?: string; write?: boolean; runner?: 'node' | 'jest' | 'vitest' | 'mocha'; verify?: boolean; existing?: string; cwd?: string; includeCovered?: boolean }
export interface GeneratedFinding extends Omit<Finding, 'status'> { requests?: string[]; status: GenerateStatus; kind: 'test' | 'todo'; reason: string | null; output: string | null; source?: string; llm?: boolean }
export interface LlmContext { finding: Finding; unitSource: string; importPath: string; runner: string; moduleStyle: 'esm' | 'cjs'; exportInfo: { kind: 'named' | 'default'; name: string } | null }
export declare function generate(report: { findings: Finding[] }, options?: GenerateOptions): GeneratedFinding[];
export declare function generateWithLlm(report: { findings: Finding[] }, options: GenerateOptions & { llm: (context: LlmContext) => Promise<string | null | undefined> | string | null | undefined }): Promise<GeneratedFinding[]>;
export interface MutantResult { description: string; kind: 'operator' | 'guard' | 'throw' | 'await' | 'nullish' | 'sanitizer'; line: number; function: string; killed: boolean; outcome: 'killed' | 'survived' | 'timeout' | 'error'; before: string; after: string }
export interface VerifyOptions { sourceFile: string; testPath?: string; runner?: 'node' | 'jest' | 'vitest' | 'mocha'; /** @internal Set by generate; ignored for callers. */ runnerSource?: 'flag' | 'detected' | 'default'; functions?: string[]; lines?: Array<number | [number, number]>; maxMutants?: number; cwd?: string; timeoutMs?: number; inPlace?: boolean; minScore?: number; maxPerKind?: number; command?: string; infraExitCodes?: number[] }
export interface VerifyResult { verified: boolean; reason: string | null; correctCode: { passed: boolean; error?: string; command?: string }; injectedBug: { passed: boolean }; runner: 'node' | 'jest' | 'vitest' | 'mocha' | null; runnerSource: 'flag' | 'detected' | 'default' | null; runnerNote?: string; mutants: MutantResult[]; killed: number; total: number; inconclusive?: number; ignored: number; mutationScore: number | null; isolation?: 'copy' | 'in-place'; sourceFile?: string; testPath?: string }
export declare function verifyGenerated(testSource: string | null, options: VerifyOptions): VerifyResult;
export interface GateIssue { file: string; test: string; kind: string; severity: 'error' | 'review'; line: number; message: string }
export interface GateResult { issues: GateIssue[]; ok: boolean; checked: number }
export declare function gate(ref: string, options?: { cwd?: string; strict?: boolean }): GateResult;
export declare function gateSarif(result: { issues: GateIssue[] }, version?: string): object;
export declare function renderHandoff(result: VerifyResult, options?: { sourceText?: string }): string;
export interface Example { method: string; path: string; status?: number; body: unknown }
export interface StubProblem { file: string; line: number; route: string; path: string; kind: 'missing' | 'extra' | 'type' | 'no-example' | 'annotation'; message: string }
export declare function loadExamples(file: string): Example[];
export declare function checkStubs(testText: string, file: string, examples: Example[]): StubProblem[];
