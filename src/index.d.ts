export interface Finding { id: string; file: string; line: number; column: number; endLine: number; function: string; rule?: string; risk: number; category: string; evidence: string; suggestion: string; status?: 'WRITTEN' | 'SCAFFOLDED' | 'FLAGGED'; verified?: boolean; covered?: boolean; branch?: boolean; endColumn?: number }
export interface Summary { score: number | null; tier: 'production-ready' | 'review-needed' | 'edge-cases-uncovered' | 'not-scored' | 'no-findings'; total: number; covered: number | null; uncovered: number | null; coverageEvidence: 'none' | 'istanbul' | 'lcov'; evidenceFile: string | null }
export interface Report { version: 1; root: string; findings: Finding[]; summary?: Summary }
export interface ScanOptions { include?: string[]; exclude?: string[]; includeTests?: boolean; coverage?: string | false; diff?: string }
export declare function scan(root?: string, options?: ScanOptions): { version: 1; root: string; findings: Finding[]; skipped: string[] };
export declare function score(report: { findings: Finding[] }, evidence?: { kind: string; source?: string }): Summary;
export declare function toSarif(report: { findings: Finding[] }, version?: string): object;
export declare function report(root?: string, options?: ScanOptions): Report;
export type GenerateStatus = 'GENERATED' | 'VERIFIED' | 'TODO' | 'FLAGGED';
export interface GenerateOptions { destination?: string; write?: boolean; runner?: 'node' | 'jest' | 'vitest' | 'mocha'; verify?: boolean; existing?: string; cwd?: string }
export interface GeneratedFinding extends Omit<Finding, 'status'> { status: GenerateStatus; kind: 'test' | 'todo'; reason: string | null; output: string | null; source?: string; llm?: boolean }
export interface LlmContext { finding: Finding; unitSource: string; importPath: string; runner: string; moduleStyle: 'esm' | 'cjs'; exportInfo: { kind: 'named' | 'default'; name: string } | null }
export declare function generate(report: { findings: Finding[] }, options?: GenerateOptions): GeneratedFinding[];
export declare function generateWithLlm(report: { findings: Finding[] }, options: GenerateOptions & { llm: (context: LlmContext) => Promise<string | null | undefined> | string | null | undefined }): Promise<GeneratedFinding[]>;
export interface MutantResult { description: string; line: number; function: string; killed: boolean; outcome: 'killed' | 'survived' | 'timeout' | 'error' }
export interface VerifyOptions { sourceFile: string; testPath?: string; runner?: "node" | "jest" | "vitest" | "mocha"; functions?: string[]; maxMutants?: number; cwd?: string; timeoutMs?: number }
export interface VerifyResult { verified: boolean; reason: string | null; correctCode: { passed: boolean; error?: string }; injectedBug: { passed: boolean }; mutants: MutantResult[]; killed: number; total: number; inconclusive?: number; mutationScore: number | null }
export declare function verifyGenerated(testSource: string | null, options: VerifyOptions): VerifyResult;
