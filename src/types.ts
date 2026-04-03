export interface PulseFeatureFlags {
  presence?: boolean;
  presenceSync?: boolean;
  selfEcho?: boolean;
}

export interface PulseMetadata {
  [key: string]: unknown;
}

export interface PulseTokenPayload {
  roomId: string;
  userId: string;
  features?: PulseFeatureFlags;
  metadata?: PulseMetadata;
  scopes?: string[];
}

export interface SessionData {
  roomId: string;
  userId: string;
  features: PulseFeatureFlags;
  metadata?: PulseMetadata;
}

export interface PresenceMember {
  userId: string;
  metadata?: PulseMetadata;
}
