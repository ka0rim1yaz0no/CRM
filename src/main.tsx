import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import App from './App.tsx'
import { ToastProvider } from './components/ToastProvider.tsx'
import { ThemeProvider } from './components/ThemeProvider.tsx'
import { UpdatePrompt } from './components/UpdatePrompt.tsx'
import { getStoredThemeKey, setAppTheme } from './lib/appTheme'
import { retryAuthorizedQuery } from './lib/sessionAuthorization'
import { registerSessionInvalidation } from './lib/sessionLifecycle'
import { socket } from './lib/socket'

setAppTheme(getStoredThemeKey())

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 5 * 60 * 1000,
            gcTime: 30 * 60 * 1000,
            refetchOnWindowFocus: "always",
            refetchOnReconnect: "always",
            refetchInterval: 60_000,
            refetchIntervalInBackground: false,
            retry: retryAuthorizedQuery,
        },
        mutations: {
            retry: false,
        },
    },
})

const stopSessionInvalidation = registerSessionInvalidation(queryClient, () => socket.disconnect())
if (import.meta.hot) import.meta.hot.dispose(stopSessionInvalidation)

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
