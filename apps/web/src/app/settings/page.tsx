"use client";

import { ProviderCredentialsPanel } from "@/components/settings/ProviderCredentialsPanel";
import { WorkerModelSettingsPanel } from "@/components/settings/WorkerModelSettingsPanel";
import { BackLink } from "@/components/ui/BackLink";

export default function SettingsPage() {
  return (
    <main className="min-h-screen bg-brand-bg px-6 py-10">
      <div className="mx-auto w-full max-w-4xl">
        <BackLink href="/projects" label="Back to projects" />
        <div className="mb-8">
          <h1 className="text-3xl font-serif text-brand-text-dark">Settings</h1>
          <p className="mt-2 text-sm text-brand-text-light">
            Manage provider access, embedding prerequisites, and desktop updates.
          </p>
        </div>
        <div className="space-y-6">
          <ProviderCredentialsPanel showUpdater />
          <WorkerModelSettingsPanel />
        </div>
      </div>
    </main>
  );
}
