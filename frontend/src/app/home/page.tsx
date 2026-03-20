import type { Metadata } from "next";
import { WelcomeLanding } from "@/components/home/welcome-landing";

export const metadata: Metadata = {
  title: "Welcome — PremChat",
  description: "Enter your sentient workspace and start talking to Prem.",
};

export default function HomePage() {
  return <WelcomeLanding />;
}
