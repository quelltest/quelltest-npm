export interface Finding { id: string; file: string; line: number; column: number; endLine: number; function: string; rule?: string; risk: number; category: string; evidence: string; suggestion: string; status?: 'WRITTEN' | 'SCAFFOLDED' | 'FLAGGED'; verified?: boolean; covered?: boolean; branch?: boolean; endColumn?: number }
export interface Summary { score: number | null; tier: 'production-ready' | 'review-needed' | 'edge-cases-uncovered' | 'not-scored' | 'no-findings'; total: number; covered: number | null; uncovered: number | null; coverageEvidence: 'none' | 'istanbul' | 'lcov'; evidenceFile: string | null }
export interface Report { version: 1; root: string; findings: Finding[]; summary?: Summary }
export interface ScanOptions { include?: string[]; exclude?: string[]; includeTests?: boolean; coverage?: string | false; diff?: string }
export declare function scan(root?: string, options?: ScanOptions): { version: 1; root: string; findings: Finding[]; skipped: string[] };
export declare function score(report: { findings: Finding[] }, evidence?: { kind: string; source?: string }): Summary;
export declare function toSarif(report: { findings: Finding[] }, version?: string): object;
export declare function report(root?: string, options?: ScanOptions): Report;
export declare function generate(report: Report, options?: { destination?: string; write?: boolean; existing?: string }): Finding[];
export declare function verifyGenerated(source: string): { correctCode: { passed: boolean; error?: string }; injectedBug: { passed: boolean; observedFailure: { passed: boolean; error?: string } } };
