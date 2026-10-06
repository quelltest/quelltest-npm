export interface Finding { id: string; file: string; line: number; column: number; category: string; evidence: string; suggestion: string; status?: 'WRITTEN' | 'SCAFFOLDED' | 'FLAGGED'; verified?: boolean }
export interface Report { version: 1; root: string; findings: Finding[]; summary?: { score: number; tier: string; total: number; covered: number; verified: number } }
export declare function scan(root?: string): { version: 1; root: string; findings: Finding[] };
export declare function score(report: { findings: Finding[] }): Report['summary'];
export declare function report(root?: string): Report;
export declare function generate(report: Report, options?: { destination?: string; write?: boolean; existing?: string }): Finding[];
