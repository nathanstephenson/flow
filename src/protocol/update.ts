export type UpdateChannel = 'stable' | 'beta';

export type UpdateEligibility =
  | { state: 'eligible' }
  | { state: 'unsupported' | 'blocked'; reason: string };

export type UpdateOperation = {
  id: string;
  state: 'updating' | 'succeeded' | 'failed' | 'unverified';
  previousVersion: string;
  targetVersion?: string;
  installedVersion?: string;
  startedAt: string;
  finishedAt?: string;
  message?: string;
};

/** The complete, credential-free answer used by Settings. */
export type WebUpdateStatus = {
  installedVersion: string;
  channel: UpdateChannel;
  updateAvailable: boolean;
  latestVersion?: string;
  checkedAt?: string;
  checkError?: string;
  eligibility: UpdateEligibility;
  operation?: UpdateOperation;
};
