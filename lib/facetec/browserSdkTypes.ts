// ─── FaceTec Browser SDK v10.1.9 — public API surface ───────────────────
//
// Transcribed directly from the SDK's own declaration files (not
// hand-guessed): FaceTecSDK-browser-10.1.9/core-sdk/FaceTecSDK.js/{FaceTecSDK,FaceTecPublicApi}.d.ts.
// Kept to exactly what LivenessStepClient.tsx uses — this SDK generation's
// only entry point is initializeWithSessionRequest (the "blob relay"
// pattern); there is no initializeInProductionMode / raw session token /
// FaceScanProcessor in this version.

export enum FaceTecInitializationError {
  RejectedByServer                    = 0,
  RequestAborted                      = 1,
  DeviceNotSupported                  = 2,
  UnknownInternalError                = 3,
  ResourcesCouldNotBeLoadedOnLastInit = 4,
  GetUserMediaRemoteHTTPNotSupported  = 5,
}

export enum FaceTecSessionStatus {
  SessionCompleted                  = 0,
  RequestAborted                    = 1,
  UserCancelledFaceScan             = 2,
  UserCancelledIDScan               = 3,
  LockedOut                         = 4,
  CameraError                       = 5,
  CameraPermissionsDenied           = 6,
  UnknownInternalError              = 7,
  IFrameNotAllowedWithoutPermission = 8,
}

export type FaceTecSessionResult = {
  status: FaceTecSessionStatus;
};

export type FaceTecSessionRequestProcessorCallback = {
  processResponse:         (responseBlob: string) => void;
  updateProgress:          (uploadPercent: number) => void;
  abortOnCatastrophicError: () => void;
};

export type FaceTecSessionRequestProcessor = {
  onSessionRequest: (requestBlob: string, requestCallback: FaceTecSessionRequestProcessorCallback) => void;
  onFaceTecExit:    (result: FaceTecSessionResult) => void;
};

export type FaceTecSDKInstance = {
  start3DLiveness: (sessionRequestProcessor: FaceTecSessionRequestProcessor) => void;
};

export type FaceTecInitializeCallback = {
  onSuccess: (sdkInstance: FaceTecSDKInstance) => void;
  onError:   (error: FaceTecInitializationError) => void;
};

export type FaceTecSDKGlobal = {
  setResourceDirectory: (resourceDirectory: string) => void;
  setImagesDirectory:   (directory: string) => void;
  initializeWithSessionRequest: (
    deviceKeyIdentifier:      string,
    sessionRequestProcessor:  FaceTecSessionRequestProcessor,
    callback:                 FaceTecInitializeCallback,
  ) => void;
  FaceTecSessionStatus:       typeof FaceTecSessionStatus;
  FaceTecInitializationError: typeof FaceTecInitializationError;
};
