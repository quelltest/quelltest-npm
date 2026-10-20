export interface Finding { id: string; file: string; line: number; column: number; endLine: number; function: string; rule?: string; risk: number; category: string; evidence: string; suggestion: string; status?: 'WRITTEN' | 'SCAFFOLDED' | 'FLAGGED'; verified?: boolean }
export interface Report { version: 1; root: string; findings: Finding[]; summary?: { score: number; tier: string; total: number; covered: number; verified: number } }
export interface ScanOptions { include?: string[]; exclude?: string[]; includeTests?: boolean }
export declare function scan(root?: string, options?: ScanOptions): { version: 1; root: string; findings: Finding[]; skipped: string[] };
export declare function score(report: { findings: Finding[] }): Report['summary'];
export declare function report(root?: string, options?: ScanOptions): Report;
export declare function generate(report: Report, options?: { destination?: string; write?: boolean; existing?: string }): Finding[];
export declare function verifyGenerated(source: string): { correctCode: { passed: boolean; error?: string }; injectedBug: { passed: boolean; observedFailure: { passed: boolean; error?: string } } };
