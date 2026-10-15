import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import App from './App.tsx'
import { ToastProvider } from './components/ToastProvider.tsx'
import { ThemeProvider } from './components/ThemeProvider.tsx'
import { UpdatePrompt } from './components/UpdatePrompt.tsx'

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 5 * 60 * 1000,
            gcTime: 30 * 60 * 1000,
            refetchOnWindowFocus: "always",
            refetchOnReconnect: "always",
            refetchInterval: 60_000,
            refetchIntervalInBackground: false,
            retry: 1,
        },
        mutations: {
            retry: false,
        },
    },
})

createRoot(document.getElementById('root')!).render(

    <QueryClientProvider client={queryClient}>
        <ToastProvider>
            <ThemeProvider>
                <App />
                <UpdatePrompt />
            </ThemeProvider>
        </ToastProvider>
    </QueryClientProvider>
)
