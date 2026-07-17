"use client";

import { Eye, EyeOff, KeyRound } from "lucide-react";
import { useState } from "react";
import styles from "./seamless.module.css";
import type { FlowCredentialRequestView } from "./types";

interface V2CredentialPromptProps {
  request: FlowCredentialRequestView;
  onResolve: (request: FlowCredentialRequestView, decision: "submitted" | "cancelled", value?: string) => void;
}

export function V2CredentialPrompt({ request, onResolve }: V2CredentialPromptProps) {
  const [value, setValue] = useState("");
  const [isVisible, setIsVisible] = useState(false);

  return (
    <div className={styles.credentialPrompt}>
      <div className={styles.credentialTitle}>
        <KeyRound aria-hidden="true" />
        <span>
          <strong>Connect {request.serverLabel}</strong>
          <small>{request.envKey}</small>
        </span>
      </div>
      <label htmlFor={`v2-credential-${request.id}`}>Credential</label>
      <div className={styles.credentialInput}>
        <input
          id={`v2-credential-${request.id}`}
          type={isVisible ? "text" : "password"}
          value={value}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && value.trim()) {
              onResolve(request, "submitted", value);
              setValue("");
            }
          }}
        />
        <button type="button" onClick={() => setIsVisible((current) => !current)} aria-label={isVisible ? "Hide credential" : "Show credential"}>
          {isVisible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
        </button>
      </div>
      <div className={styles.credentialActions}>
        <button type="button" onClick={() => onResolve(request, "cancelled")}>Cancel</button>
        <button
          type="button"
          disabled={!value.trim()}
          onClick={() => {
            onResolve(request, "submitted", value);
            setValue("");
          }}
        >
          Save and continue
        </button>
      </div>
    </div>
  );
}
