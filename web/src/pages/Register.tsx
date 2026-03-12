import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../contexts/auth";
import { useI18n } from "../contexts/i18n";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import { Button, Input } from "../components/ui";
import { Brain, User, Lock, ShieldCheck } from "lucide-react";

export default function Register() {
  const { t } = useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  const { register } = useAuth();
  const navigate = useNavigate();

  const passwordRules = [
    {
      test: (value: string) => value.length >= 8,
      label: t("register.secretRules.length"),
    },
    {
      test: (value: string) => /[A-Z]/.test(value),
      label: t("register.secretRules.uppercase"),
    },
    {
      test: (value: string) => /[a-z]/.test(value),
      label: t("register.secretRules.lowercase"),
    },
    {
      test: (value: string) => /\d/.test(value),
      label: t("register.secretRules.digit"),
    },
  ];

  const validateForm = (): boolean => {
    const errors: Record<string, string> = {};

    // Username validation
    if (username.length < 2) {
      errors.username = t("register.usernameMin");
    } else if (username.length > 64) {
      errors.username = t("register.usernameMax");
    } else if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      errors.username = t("register.usernamePattern");
    }

    // Password strength validation
    const failedRules = passwordRules.filter((r) => !r.test(password));
    if (failedRules.length > 0) {
      errors.password = failedRules.map((r) => r.label).join(", ");
    }

    // Confirm password
    if (password !== confirmPassword) {
      errors.confirmPassword = t("register.credentialsMismatch");
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async () => {
    setError("");

    if (!validateForm()) return;

    setLoading(true);
    try {
      await register(username, password);
      navigate("/");
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("register.registrationFailed");
      // 尝试从 API 响应中提取更具体的错误信息
      if (msg.includes("409") || msg.includes("already exists")) {
        setError(t("register.usernameExists"));
      } else if (msg.includes("429")) {
        setError(t("register.tooManyAttempts"));
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <LanguageSwitcher className="absolute top-4 right-4" />
      <div className="bg-white rounded-xl shadow-lg p-8 w-full max-w-md">
        <div className="text-center mb-6">
          <Brain className="w-12 h-12 text-primary-600 mx-auto mb-2" />
          <h1 className="text-2xl font-bold text-slate-900">
            {t("common.appName")}
          </h1>
          <p className="text-sm text-slate-500 mt-1">{t("register.title")}</p>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4">
            {error}
          </div>
        )}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit();
          }}
          className="space-y-4"
        >
          <Input
            label={t("auth.username")}
            icon={<User size={16} />}
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={t("register.chooseUsername")}
            required
            autoComplete="username"
            error={fieldErrors.username}
          />

          <div>
            <Input
              label={t("auth.credentialLabel")}
              icon={<Lock size={16} />}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("register.createStrongCredential")}
              required
              autoComplete="new-password"
              error={fieldErrors.password}
            />

            {/* Password strength indicators */}
            {password.length > 0 && (
              <div className="mt-2 space-y-1">
                {passwordRules.map((rule) => (
                  <div
                    key={rule.label}
                    className={`flex items-center gap-1.5 text-xs ${
                      rule.test(password) ? "text-green-600" : "text-slate-400"
                    }`}
                  >
                    <ShieldCheck className="w-3 h-3" />
                    {rule.label}
                  </div>
                ))}
              </div>
            )}
          </div>

          <Input
            label={t("register.confirmCredential")}
            icon={<Lock size={16} />}
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder={t("register.confirmYourCredential")}
            required
            autoComplete="new-password"
            error={fieldErrors.confirmPassword}
          />

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? t("register.creatingAccount") : t("register.createAccount")}
          </Button>
        </form>

        <div className="mt-4 text-center">
          <span className="text-sm text-slate-500">
            {t("auth.alreadyHaveAccount")} {" "}
            <Link
              to="/login"
              className="text-primary-600 hover:text-primary-700 font-medium"
            >
              {t("auth.signInLink")}
            </Link>
          </span>
        </div>
      </div>
    </div>
  );
}
