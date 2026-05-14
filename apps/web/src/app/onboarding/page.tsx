"use client";

import { motion } from "framer-motion";
import { Button } from "@/components/ui/Button";

export default function OnboardingPage() {
  return (
    <main className="min-h-screen bg-brand-bg flex items-center justify-center p-6">
      <motion.div 
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="max-w-md w-full"
      >
        <h1 className="text-3xl font-serif mb-6 text-brand-text-dark text-center">Welcome to Socrates</h1>
        <p className="text-brand-text-light mb-8 text-center text-lg">What should we call you?</p>
        <form className="flex flex-col gap-4">
          <input 
            type="text" 
            placeholder="Your name" 
            className="px-5 py-4 bg-white border border-gray-200 rounded-xl outline-none focus:border-brand-teal-dark shadow-sm text-lg transition-colors"
          />
          <Button type="button" className="w-full py-6 rounded-xl text-base">
            Continue
          </Button>
        </form>
      </motion.div>
    </main>
  );
}
