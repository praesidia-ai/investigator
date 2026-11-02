export function startIndependentObserver(options: {
  subjectRevision: string;
  credential: string;
}): Promise<{ baseUrl: string; close(): Promise<void> }>;
