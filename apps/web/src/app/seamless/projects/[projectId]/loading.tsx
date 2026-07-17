import { LivingSphere } from "@/components/v2/LivingSphere";
import styles from "@/components/v2/seamless.module.css";

export default function SeamlessProjectLoading() {
  return (
    <main className={styles.routeStatePage}>
      <div className={styles.oceanNoise} aria-hidden="true" />
      <LivingSphere state="routing" size="compact" statusLabel="Opening project flow" />
    </main>
  );
}
