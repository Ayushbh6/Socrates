import { create } from 'zustand'
import type { User, Project, Conversation } from '../types/api'

interface AppState {
  user: User | null
  activeProject: Project | null
  activeConversation: Conversation | null
  setUser: (user: User | null) => void
  setActiveProject: (project: Project | null) => void
  setActiveConversation: (conversation: Conversation | null) => void
}

export const useAppStore = create<AppState>((set) => ({
  user: null,
  activeProject: null,
  activeConversation: null,
  setUser: (user) => set({ user }),
  setActiveProject: (activeProject) => set({ activeProject, activeConversation: null }),
  setActiveConversation: (activeConversation) => set({ activeConversation }),
}))
