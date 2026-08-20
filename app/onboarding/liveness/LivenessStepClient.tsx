'use client';

import { useEffect, useRef, useState } from 'react';
import {
  getFaceTecInitParams,
  relayFaceTecSessionRequest,
  runLiveness,
} from '@/lib/onboarding/actions';
import {
  FaceTecInitializationError,
  type FaceTecSDKGlobal,
  type FaceTecSDKInstance,
  type FaceTecSessionRequestProcessor,
  type FaceTecSessionResult,
} from '@/lib/facetec/browserSdkTypes';

// ─── Liveness step (client) — FaceTec Browser SDK integration ──────────
//
// Uses the SDK's actual (only) entry point in v10.1.9: initializeWithSessionRequest.
// The SDK never hands us raw biometric data — every round trip, both the
// init handshake and the real capture, is an opaque encrypted blob our
// backend blind-relays to FaceTec via relayFaceTecSessionRequest (see
// lib/facetec/relay.ts). The one signal we DO get is the session's exit
// status, which runLiveness() gates on (see
// lib/onboarding/liveness/livenessCheck.ts for that module's documented
// limitation: it trusts the client-reported status until the relay's raw
// `result` field is confirmed against FaceTec's actual response shape).
//
// Static SDK assets (FaceTecSDK.js, resources, images) live in
// public/facetec/core-sdk/ — copied verbatim from the v10.1.9 zip, which
// is the SAME version this file's types were transcribed from
// (lib/facetec/browserSdkTypes.ts).

declare global {
  interface Window {
    FaceTecSDK?: FaceTecSDKGlobal;
  }
}

const SDK_SCRIPT_SRC   = '/facetec/core-sdk/FaceTecSDK.js';
const SDK_RESOURCE_DIR = '/facetec/core-sdk/resources';
const SDK_IMAGES_DIR   = '/facetec/core-sdk/FaceTec_images';

const UNAVAILABLE_MESSAGE =
  'Face verification isn’t available right now. Please try again later or contact support.';

type Phase = 'loading-sdk' | 'ready' | 'capturing' | 'unavailable';

/**
 * Every round trip the SDK makes is an opaque blob relayed blind through
 * our backend to FaceTec — the init handshake and the real capture share
 * this exact same relaying logic. Only what happens at session exit
 * differs between the two use sites.
 */
function makeSessionRequestProcessor(
  onExit: (result: FaceTecSessionResult) => void,
): FaceTecSessionRequestProcessor {
  return {
    onSessionRequest: (requestBlob, callback) => {
      void (async () => {
        const result = await relayFaceTecSessionRequest(requestBlob);
        if (result.error || !result.responseBlob) {
          callback.abortOnCatastrophicError();
          return;
        }
        callback.processResponse(result.responseBlob);
      })();
    },
    onFaceTecExit: onExit,
  };
}

export default function LivenessStepClient() {
  const [phase, setPhase] = useState<Phase>('loading-sdk');
  const [error, setError] = useState<string | null>(null);
  const bootedRef       = useRef(false);
  const sdkInstanceRef  = useRef<FaceTecSDKInstance | null>(null);

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    let cancelled = false;

    async function boot() {
      const initResult = await getFaceTecInitParams();
      if (cancelled) return;
      if (initResult.error || !initResult.config) {
        setError(initResult.error ?? UNAVAILABLE_MESSAGE);
        setPhase('unavailable');
        return;
      }
      const { deviceKeyIdentifier } = initResult.config;

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

        // The init-time processor isn't expected to see onFaceTecExit —
        // that only fires once a real session (start3DLiveness) runs.
        const initProcessor = makeSessionRequestProcessor(() => {});

        sdk.initializeWithSessionRequest(deviceKeyIdentifier, initProcessor, {
          onSuccess: (sdkInstance) => {
            if (cancelled) return;
            sdkInstanceRef.current = sdkInstance;
            setPhase('ready');
          },
          onError: (initError) => {
            console.error('[liveness] FaceTecSDK initialization failed', FaceTecInitializationError[initError]);
            if (!cancelled) {
              setError(UNAVAILABLE_MESSAGE);
              setPhase('unavailable');
            }
          },
        });
      };
      document.head.appendChild(script);
    }

    boot();
    return () => { cancelled = true; };
  }, []);

  function handleStart() {
    const sdk         = window.FaceTecSDK;
    const sdkInstance = sdkInstanceRef.current;
    if (!sdk || !sdkInstance || phase !== 'ready') return;
    setError(null);
    setPhase('capturing');

    const processor = makeSessionRequestProcessor((result) => {
      void (async () => {
        const sessionCompleted = result.status === sdk.FaceTecSessionStatus.SessionCompleted;
        const outcome = await runLiveness({ sessionCompleted });
        if (outcome.error) {
          setError(outcome.error);
          setPhase('ready');
          return;
        }
        window.location.href = outcome.nextPath ?? '/onboarding';
      })();
    });

    sdkInstance.start3DLiveness(processor);
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
        {phase === 'unavailable' && 'Unavailable'}
      </button>
    </div>
  );
}
