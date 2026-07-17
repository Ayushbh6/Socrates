"use client";

import { api } from "@/lib/api";
import { formatUpdatedAt } from "@/lib/dates";
import type { ListProjectsResponse } from "@socrates/contracts";
import { ArrowRight, ArrowUpRight, FolderPlus, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { LivingSphere } from "./LivingSphere";
import { V2ViewLink } from "./V2ViewLink";
import { useV2Capabilities } from "@/lib/v2/useV2Capabilities";
import styles from "./seamless.module.css";

export function SeamlessProjectDirectory() {
  const availability = useV2Capabilities();
  const [projects, setProjects] = useState<ListProjectsResponse["projects"]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await api.listProjects();
      setProjects(data.projects);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load projects.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let isMounted = true;

    async function loadInitialProjects() {
      try {
        const data = await api.listProjects();
        if (isMounted) {
          setProjects(data.projects);
          setError(null);
        }
      } catch (loadError) {
        if (isMounted) {
          setError(loadError instanceof Error ? loadError.message : "Could not load projects.");
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    void loadInitialProjects();
    return () => {
      isMounted = false;
    };
  }, []);

  if (availability.isLoading) {
    return (
      <main className={styles.routeStatePage}>
        <div className={styles.oceanNoise} aria-hidden="true" />
        <LivingSphere state="routing" size="compact" statusLabel="Checking Seamless availability" />
      </main>
    );
  }

  if (!availability.enabled) {
    return (
      <main className={styles.routeStatePage}>
        <div className={styles.oceanNoise} aria-hidden="true" />
        <LivingSphere state="offline" size="compact" statusLabel="Seamless View is disabled" />
        <p role={availability.error ? "alert" : undefined}>
          {availability.error ?? "This build keeps the isolated V2 Flow runtime turned off. Classic View remains available and unchanged."}
        </p>
        <V2ViewLink view="classic" href="/projects" className={styles.classicSwitch}>
          Classic View
          <ArrowUpRight aria-hidden="true" />
        </V2ViewLink>
      </main>
    );
  }

  return (
    <main className={styles.directoryPage}>
      <div className={styles.oceanNoise} aria-hidden="true" />
      <header className={styles.directoryHeader}>
        <Link className={styles.directoryBrand} href="/welcome">Socrates</Link>
        <V2ViewLink view="classic" href="/projects" className={styles.classicSwitch}>
          <span>Classic View</span>
          <ArrowUpRight aria-hidden="true" />
        </V2ViewLink>
      </header>

      <section className={styles.directoryContent} aria-labelledby="seamless-projects-title">
        <div className={styles.directoryIntro}>
          <div>
            <p className={styles.kicker}>Seamless View</p>
            <h1 id="seamless-projects-title">Choose a project flow.</h1>
            <p>Each project has one continuous visible timeline. Its goals and working context stay scoped behind it.</p>
          </div>
          <LivingSphere
            state={error ? "error" : isLoading ? "routing" : "idle"}
            size="mini"
            statusLabel={error ? "Projects unavailable" : isLoading ? "Loading projects" : "Select a project"}
          />
        </div>

        <div className={styles.projectDirectory} aria-live="polite" aria-busy={isLoading}>
          {isLoading && (
            <div className={styles.directoryStatus}>
              <span className={styles.loadingLine} />
              <span className={styles.loadingLine} />
              <span className={styles.loadingLine} />
            </div>
          )}

          {!isLoading && error && (
            <div className={styles.directoryStatus} role="alert">
              <p>{error}</p>
              <button type="button" onClick={() => void loadProjects()}>
                <RefreshCw aria-hidden="true" />
                Try again
              </button>
            </div>
          )}

          {!isLoading && !error && projects.length === 0 && (
            <div className={styles.directoryStatus}>
              <p>No projects yet. Create one first, then open its Seamless flow.</p>
              <Link href="/projects/new">
                <FolderPlus aria-hidden="true" />
                Create project in Classic View
              </Link>
            </div>
          )}

          {!isLoading && !error && projects.length > 0 && (
            <ul className={styles.directoryList}>
              {projects.map(({ project, primaryWorkspace, lastActivityAt }) => (
                <li key={project.id}>
                  <Link href={`/seamless/projects/${encodeURIComponent(project.id)}`}>
                    <span className={styles.directoryProjectMark} aria-hidden="true">
                      {project.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className={styles.directoryProjectCopy}>
                      <strong>{project.name}</strong>
                      <span>{project.description ?? primaryWorkspace.path ?? "No description"}</span>
                    </span>
                    <span className={styles.directoryProjectMeta}>
                      <span>{primaryWorkspace.path ? "Workspace connected" : "No workspace folder"}</span>
                      <span>Updated {formatUpdatedAt(lastActivityAt ?? project.updatedAt)}</span>
                    </span>
                    <ArrowRight className={styles.directoryProjectArrow} aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </main>
  );
}
