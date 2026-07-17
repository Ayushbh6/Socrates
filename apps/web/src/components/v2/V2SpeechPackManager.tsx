"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  AlertCircle,
  AudioLines,
  Check,
  Download,
  HardDrive,
  Mic2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Volume2,
} from "lucide-react";
import { useV2SpeechPacks } from "@/lib/v2/useV2SpeechPacks";
import {
  V2_SPEECH_PACK_CATALOG,
  V2_SPEECH_PACK_IDS,
  type V2SpeechPack,
  type V2SpeechPackId,
} from "@/lib/v2/speechPacksApi";
import styles from "./speechPacks.module.css";

interface V2SpeechPackManagerProps {
  className?: string;
  headingId?: string;
}

const sizeLabel = (bytes: number): string =>
  `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(bytes / (1024 * 1024))} MB`;

const packState = (
  pack: V2SpeechPack,
  action: "installing" | "removing" | undefined,
): { label: string; tone: "ready" | "idle" | "busy" | "repair" } => {
  if (action === "installing") return { label: "Installing", tone: "busy" };
  if (action === "removing") return { label: "Removing", tone: "busy" };
  if (pack.installed && pack.verified) return { label: "Ready", tone: "ready" };
  if (pack.installed) return { label: "Needs repair", tone: "repair" };
  return { label: "Not installed", tone: "idle" };
};

const PackIcon = ({ packId }: { packId: V2SpeechPackId }) =>
  packId === "kokoro-en-v0_19"
    ? <Volume2 aria-hidden="true" />
    : <Mic2 aria-hidden="true" />;

export function V2SpeechPackManager({ className, headingId = "v2-offline-voice-title" }: V2SpeechPackManagerProps) {
  const reduceMotion = useReducedMotion();
  const {
    packs,
    isLoading,
    loadError,
    actions,
    packErrors,
    installedCount,
    isBusy,
    refresh,
    install,
    remove,
  } = useV2SpeechPacks();
  const packsById = new Map(packs.map((pack) => [pack.id, pack]));

  return (
    <motion.section
      className={[styles.manager, className].filter(Boolean).join(" ")}
      aria-labelledby={headingId}
      aria-busy={isLoading || isBusy}
      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.28, ease: [0.22, 1, 0.36, 1] }}
    >
      <header className={styles.header}>
        <div className={styles.titleGroup}>
          <span className={styles.kicker}>
            <AudioLines aria-hidden="true" />
            Local voice
          </span>
          <h2 id={headingId}>Offline speech packs</h2>
          <p>Install only the English models you want Socrates to use on this machine.</p>
        </div>
        <div className={styles.headerStatus}>
          <span>{installedCount} of {V2_SPEECH_PACK_IDS.length} ready</span>
          <button
            type="button"
            className={styles.refreshButton}
            onClick={() => void refresh()}
            disabled={isLoading || isBusy}
            aria-label="Refresh offline speech pack status"
            title="Refresh status"
          >
            <RefreshCw aria-hidden="true" data-spinning={isLoading ? "true" : "false"} />
          </button>
        </div>
      </header>

      <AnimatePresence initial={false}>
        {loadError ? (
          <motion.div
            className={styles.loadError}
            role="alert"
            initial={reduceMotion ? false : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.2 }}
          >
            <AlertCircle aria-hidden="true" />
            <span>{loadError}</span>
            <button type="button" onClick={() => void refresh()}>Try again</button>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <ul className={styles.packList} aria-live="polite">
        {V2_SPEECH_PACK_IDS.map((packId, index) => {
          const pack = packsById.get(packId) ?? { id: packId, installed: false, verified: false, path: "" };
          const detail = V2_SPEECH_PACK_CATALOG[packId];
          const action = actions[packId];
          const state = packState(pack, action);
          const error = packErrors[packId];
          const isInstalled = pack.installed && pack.verified;
          return (
            <motion.li
              key={packId}
              className={styles.packRow}
              initial={reduceMotion ? false : { opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.24, delay: reduceMotion ? 0 : 0.04 * index }}
              data-busy={action ? "true" : "false"}
            >
              <span className={styles.packIcon} data-ready={isInstalled ? "true" : "false"}>
                <PackIcon packId={packId} />
              </span>

              <div className={styles.packCopy}>
                <div className={styles.packHeading}>
                  <strong>{detail.name}</strong>
                  <span className={styles.packState} data-tone={state.tone} role="status">
                    <i aria-hidden="true" />
                    {state.label}
                  </span>
                </div>
                <p>{detail.description}</p>
                <div className={styles.packMeta}>
                  <span><HardDrive aria-hidden="true" />{sizeLabel(detail.sizeBytes)}</span>
                  <span>{detail.purpose}</span>
                  <span>{detail.modelId}</span>
                </div>
                <AnimatePresence initial={false}>
                  {error ? (
                    <motion.p
                      className={styles.packError}
                      role="alert"
                      initial={reduceMotion ? false : { opacity: 0, y: -3 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -3 }}
                      transition={{ duration: reduceMotion ? 0 : 0.2 }}
                    >
                      <AlertCircle aria-hidden="true" />
                      {error}
                    </motion.p>
                  ) : null}
                </AnimatePresence>
              </div>

              <button
                type="button"
                className={styles.packAction}
                data-kind={isInstalled ? "remove" : "install"}
                disabled={isLoading || Boolean(action) || (isBusy && !action)}
                onClick={() => void (isInstalled ? remove(packId) : install(packId))}
                title={isInstalled && pack.path ? `Installed at ${pack.path}` : undefined}
              >
                {action ? (
                  <>
                    <RefreshCw aria-hidden="true" className={styles.spin} />
                    {action === "installing" ? "Installing" : "Removing"}
                  </>
                ) : isInstalled ? (
                  <>
                    <Trash2 aria-hidden="true" />
                    Remove
                  </>
                ) : (
                  <>
                    <Download aria-hidden="true" />
                    Install
                  </>
                )}
              </button>

              {action ? (
                <span className={styles.progressTrack} aria-hidden="true">
                  <span />
                </span>
              ) : null}
            </motion.li>
          );
        })}
      </ul>

      <footer className={styles.footer}>
        <ShieldCheck aria-hidden="true" />
        <span>
          <strong>Explicit engine selection.</strong>
          Hosted transcription is never chosen as a fallback when a local pack is missing.
        </span>
        <span className={styles.verifiedMark} title="Downloads are verified before installation">
          <Check aria-hidden="true" />
          Verified downloads
        </span>
      </footer>
    </motion.section>
  );
}
