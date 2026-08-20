'use client';

import { useEffect, useRef, useState } from 'react';
import {
  getFaceTecInitParams,
  getFaceTecSessionTokenForOnboarding,
  runLiveness,
} from '@/lib/onboarding/actions';

// ─── Liveness step (client) — FaceTec integration ───────────────────────
//
// ⚠️  ONE REMAINING SEAM — READ BEFORE TOUCHING window.FaceTecSDK CALLS.  ⚠️
//
// Everything except the exact SDK method surface below is real and
// already wired: lib/facetec/datanamixClient.ts calls Datanamix's live
// FaceTec Server SDK (session-token, liveness-3d), lib/onboarding/actions.ts
// gates the onboarding step on its verdict, and a pass writes
// profiles.liveness_verified_at for real.
//
// What's unverified is the exact `window.FaceTecSDK` API this file calls.
// Datanamix's /session-token example response confirms their server runs
// FaceTec Core Server SDK 9.7.25 — the CLASSIC integration generation
// (initializeInProductionMode + `new FaceTecSession(...)`, where a
// FaceScanProcessor receives the raw base64 FaceScan directly). The
// FaceTec Browser SDK v10.1.9 zip bundled with this project does NOT
// implement that: its FaceTecSDK.d.ts exposes exactly one entry point,
// `initializeWithSessionRequest`, which speaks a different, opaque
// encrypted-blob-relay protocol that Datanamix's documented REST API has
// no endpoint for. So the classic asset this file expects at
// /facetec/core-sdk/FaceTecSDK.js isn't in the repo yet — get a build
// that matches Server SDK 9.7.25 from https://dev.facetec.com/signin
// (Datanamix's docs give the download password "ZoomPBSA"; ask Datanamix
// support which Browser SDK version to use if unsure), drop its
// `core-sdk/` directory at `public/facetec/core-sdk/`, then verify the
// method names below against THAT build's own .d.ts files — FaceTec has
// renamed things across major versions before. Until then this component
// fails closed with a clear "not available" message (see the
// 'unavailable' phase) rather than pretending to work.

declare global {
  interface Window {
    FaceTecSDK?: FaceTecSDKGlobal;
  }
}

// Minimal surface used here — NOT the SDK's own type declarations. Once
// the real build is in place, prefer importing its shipped .d.ts instead
// of this hand-written shim.
type FaceTecSDKGlobal = {
  setResourceDirectory: (dir: string) => void;
  setImagesDirectory:   (dir: string) => void;
  initializeInProductionMode: (
    productionKeyText:           string,
    deviceKeyIdentifier:         string,
    publicFaceScanEncryptionKey: string,
    callback: {
      onSuccess: () => void;
      onFaceTecSDKInitializationFailure: (error: unknown) => void;
    },
  ) => void;
  createFaceTecAPIUserAgentString: (sessionId: string) => string;
  FaceTecSession: new (sessionToken: string, processor: FaceTecFaceScanProcessor) => unknown;
  FaceTecSessionStatus: { SessionCompletedSuccessfully: unknown };
};

type FaceTecSessionResult = {
  status:               unknown;
  sessionId:            string;
  faceScan:             string | null;
  auditTrail:           string[];
  lowQualityAuditTrail: string[];
};

type FaceScanResultCallback = {
  succeed: () => void;
  cancel:  () => void;
};

type FaceTecFaceScanProcessor = {
  processSessionResultWhileFaceTecSDKWaits: (
    sessionResult: FaceTecSessionResult,
    callback:      FaceScanResultCallback,
  ) => void;
  onFaceTecSDKSessionCompletelyDone: () => void;
};

const SDK_SCRIPT_SRC   = '/facetec/core-sdk/FaceTecSDK.js';
const SDK_RESOURCE_DIR = '/facetec/core-sdk/resources';
const SDK_IMAGES_DIR   = '/facetec/core-sdk/FaceTec_images';

const UNAVAILABLE_MESSAGE =
  'Face verification isn’t available right now. Please try again later or contact support.';

type Phase = 'loading-sdk' | 'ready' | 'capturing' | 'submitting' | 'unavailable';

export default function LivenessStepClient() {
  const [phase, setPhase] = useState<Phase>('loading-sdk');
  const [error, setError] = useState<string | null>(null);
  const bootedRef = useRef(false);

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    let cancelled = false;

    async function boot() {
      const initResult = await getFaceTecInitParams();
      if (cancelled) return;
      if (initResult.error || !initResult.keys) {
        setError(initResult.error ?? UNAVAILABLE_MESSAGE);
        setPhase('unavailable');
        return;
      }

      const script = document.createElement('script');
      script.src = SDK_SCRIPT_SRC;
      script.onerror = () => {
        if (cancelled) return;
        setError(UNAVAILABLE_MESSAGE);
        setPhase('unavailable');
      };
      script.onload = () => {
        if (cancelled) return;
        const sdk = window.FaceTecSDK;
        if (!sdk) {
          setError(UNAVAILABLE_MESSAGE);
          setPhase('unavailable');
          return;
        }
        sdk.setResourceDirectory(SDK_RESOURCE_DIR);
        sdk.setImagesDirectory(SDK_IMAGES_DIR);
        sdk.initializeInProductionMode(
          initResult.keys.productionKeyText,
          initResult.keys.deviceKeyIdentifier,
          initResult.keys.publicFaceMapEncryptionKey,
          {
            onSuccess: () => { if (!cancelled) setPhase('ready'); },
            onFaceTecSDKInitializationFailure: (initError) => {
              console.error('[liveness] FaceTecSDK initialization failed', initError);
              if (!cancelled) {
                setError(UNAVAILABLE_MESSAGE);
                setPhase('unavailable');
              }
            },
          },
        );
      };
      document.head.appendChild(script);
    }

    boot();
    return () => { cancelled = true; };
  }, []);

  function handleStart() {
    const sdk = window.FaceTecSDK;
    if (!sdk || phase !== 'ready') return;
    setError(null);
    setPhase('capturing');

    const tokenUserAgent = sdk.createFaceTecAPIUserAgentString('');

    void (async () => {
      const tokenResult = await getFaceTecSessionTokenForOnboarding(tokenUserAgent);
      if (tokenResult.error || !tokenResult.sessionToken) {
        setError(tokenResult.error ?? UNAVAILABLE_MESSAGE);
        setPhase('ready');
        return;
      }

      new sdk.FaceTecSession(tokenResult.sessionToken, {
        processSessionResultWhileFaceTecSDKWaits: (sessionResult, callback) => {
          void (async () => {
            if (sessionResult.status !== sdk.FaceTecSessionStatus.SessionCompletedSuccessfully || !sessionResult.faceScan) {
              callback.cancel();
              setPhase('ready');
              return;
            }

            setPhase('submitting');
            const result = await runLiveness({
              faceScan:                  sessionResult.faceScan,
              auditTrailImage:           sessionResult.auditTrail[0] ?? '',
              lowQualityAuditTrailImage: sessionResult.lowQualityAuditTrail[0] ?? '',
              xUserAgent:                sdk.createFaceTecAPIUserAgentString(sessionResult.sessionId),
            });

            if (result.error) {
              callback.cancel();
              setError(result.error);
              setPhase('ready');
              return;
            }

            callback.succeed();
            window.location.href = result.nextPath ?? '/onboarding';
          })();
        },
        onFaceTecSDKSessionCompletelyDone: () => {
          setPhase((p) => (p === 'submitting' ? p : 'ready'));
        },
      });
    })();
  }

  return (
    <div className="flex flex-1 flex-col" data-testid="onboarding-liveness">
      <p className="text-[14px] leading-[1.65]" style={{ color: '#41556F' }}>
        {phase === 'unavailable'
          ? 'We ran into a problem starting the face check.'
          : 'Tap when you’re ready. We’ll ask for camera access and guide you through a brief check.'}
      </p>

      {error && (
        <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={handleStart}
        disabled={phase !== 'ready'}
        data-testid="onboarding-liveness-run"
        className="mt-auto flex h-[54px] w-full items-center justify-center rounded-2xl text-[15px] font-semibold text-white transition-all disabled:opacity-45 disabled:cursor-not-allowed"
        style={{ background: '#15A89E', boxShadow: phase === 'ready' ? '0 10px 22px -12px rgba(21,168,158,0.9)' : 'none' }}
      >
        {phase === 'loading-sdk' && 'Preparing…'}
        {phase === 'ready' && 'Start face check'}
        {phase === 'capturing' && 'Verifying…'}
        {phase === 'submitting' && 'Verifying…'}
        {phase === 'unavailable' && 'Unavailable'}
      </button>
    </div>
  );
}
