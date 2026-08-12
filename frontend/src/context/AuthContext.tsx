import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  ApiError,
  clearToken,
  changePassword as apiChangePassword,
  getMe,
  getSetupStatus,
  login as apiLogin,
  logout as apiLogout,
  registerOwner as apiRegisterOwner,
  setToken,
  updateMyTimezone as apiUpdateMyTimezone,
  type User,
} from '@/lib/api';

interface AuthContextValue {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  needsOwnerSetup: boolean;
  login: (email: string, password: string) => Promise<void>;
  registerOwner: (name: string, email: string, password: string) => Promise<void>;
  changePassword: (newPassword: string, confirmPassword: string) => Promise<void>;
  updateTimezone: (timezone: string) => Promise<void>;
  logout: () => Promise<void>;
  hasPermission: (slug: string) => boolean;
  hasAnyPermission: (slugs: string[]) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [needsOwnerSetup, setNeedsOwnerSetup] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem('domx_token');

    const setupPromise = getSetupStatus()
      .then(({ needsOwnerSetup: needsSetup }) => setNeedsOwnerSetup(needsSetup))
      .catch(() => setNeedsOwnerSetup(false));

    const authPromise = token
      ? (async () => {
          const delays = [0, 800, 1600, 3200];
          for (let i = 0; i < delays.length; i += 1) {
            if (delays[i]) {
              await new Promise((resolve) => setTimeout(resolve, delays[i]));
            }
            try {
              const { user } = await getMe();
              setUser(user);
              return;
            } catch (err) {
              const status = err instanceof ApiError ? err.status : 0;
              if (status === 401) {
                clearToken();
                setUser(null);
                return;
              }
              if (i === delays.length - 1) {
                setUser(null);
              }
            }
          }
        })()
      : Promise.resolve();

    Promise.all([setupPromise, authPromise]).finally(() => setIsLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const { token, user } = await apiLogin(email, password);
    setToken(token);
    setUser(user);
  }, []);

  const registerOwner = useCallback(
    async (name: string, email: string, password: string) => {
      const { token, user } = await apiRegisterOwner(name, email, password);
      setToken(token);
      setUser(user);
      setNeedsOwnerSetup(false);
    },
    []
  );

  const changePassword = useCallback(
    async (newPassword: string, confirmPassword: string) => {
      const { user: updatedUser } = await apiChangePassword(newPassword, confirmPassword);
      setUser(updatedUser);
    },
    []
  );

  const updateTimezone = useCallback(async (timezone: string) => {
    const { user: updatedUser } = await apiUpdateMyTimezone(timezone);
    setUser(updatedUser);
  }, []);

  const logout = useCallback(async () => {
    await apiLogout();
    clearToken();
    setUser(null);
  }, []);

  const hasPermission = useCallback(
    (slug: string) => {
      return user?.permissions?.includes(slug) ?? false;
    },
    [user]
  );

  const hasAnyPermission = useCallback(
    (slugs: string[]) => {
      if (!user?.permissions) return false;
      return slugs.some((slug) => user.permissions.includes(slug));
    },
    [user]
  );

  const value = useMemo(
    () => ({
      user,
      isLoading,
      isAuthenticated: !!user,
      needsOwnerSetup,
      login,
      registerOwner,
      changePassword,
      updateTimezone,
      logout,
      hasPermission,
      hasAnyPermission,
    }),
    [
      user,
      isLoading,
      needsOwnerSetup,
      login,
      registerOwner,
      changePassword,
      updateTimezone,
      logout,
      hasPermission,
      hasAnyPermission,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
