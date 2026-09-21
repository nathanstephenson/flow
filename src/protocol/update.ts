export type UpdateEligibility =
  | { state: 'eligible' }
  | { state: 'unsupported' | 'blocked'; reason: string };

export type UpdateOperation = {
  id: string;
  state: 'updating' | 'succeeded' | 'failed' | 'unverified';
  previousVersion: string;
  installedVersion?: string;
  startedAt: string;
  finishedAt?: string;
  message?: string;
};

/** The complete, credential-free answer used by Settings. */
export type WebUpdateStatus = {
  installedVersion: string;
  updateAvailable: boolean;
  latestVersion?: string;
  checkedAt?: string;
  checkError?: string;
  eligibility: UpdateEligibility;
  operation?: UpdateOperation;
};
