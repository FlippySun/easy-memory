import { useState, type FormEvent } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../contexts/auth";
import { Button, Input } from "../components/ui";
import { Brain, User, Lock, ShieldCheck } from "lucide-react";

/** 密码强度校验规则 */
const PASSWORD_RULES = [
  { test: (p: string) => p.length >= 8, label: "At least 8 characters" },
  { test: (p: string) => /[A-Z]/.test(p), label: "One uppercase letter" },
  { test: (p: string) => /[a-z]/.test(p), label: "One lowercase letter" },
  { test: (p: string) => /[0-9]/.test(p), label: "One digit" },
];

export default function Register() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  const { register } = useAuth();
  const navigate = useNavigate();

  const validateForm = (): boolean => {
    const errors: Record<string, string> = {};

    // Username validation
    if (username.length < 2) {
      errors.username = "Username must be at least 2 characters";
    } else if (username.length > 64) {
      errors.username = "Username must be at most 64 characters";
    } else if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      errors.username =
        "Username can only contain letters, numbers, underscores and hyphens";
    }

    // Password strength validation
    const failedRules = PASSWORD_RULES.filter((r) => !r.test(password));
    if (failedRules.length > 0) {
      errors.password = failedRules.map((r) => r.label).join(", ");
    }

    // Confirm password
    if (password !== confirmPassword) {
      errors.confirmPassword = "Passwords do not match";
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");

    if (!validateForm()) return;

    setLoading(true);
    try {
      await register(username, password);
      navigate("/");
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Registration failed";
      // 尝试从 API 响应中提取更具体的错误信息
      if (msg.includes("409") || msg.includes("already exists")) {
        setError("Username already exists. Please choose a different one.");
      } else if (msg.includes("429")) {
        setError("Too many registration attempts. Please try again later.");
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-lg p-8 w-full max-w-md">
        <div className="text-center mb-6">
          <Brain className="w-12 h-12 text-primary-600 mx-auto mb-2" />
          <h1 className="text-2xl font-bold text-slate-900">
            Easy Memory
          </h1>
          <p className="text-sm text-slate-500 mt-1">Create your account</p>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Username
            </label>
            <div className="relative">
              <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <Input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="pl-10"
                placeholder="Choose a username"
                required
                autoComplete="username"
              />
            </div>
            {fieldErrors.username && (
              <p className="mt-1 text-sm text-red-600">
                {fieldErrors.username}
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Password
            </label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="pl-10"
                placeholder="Create a strong password"
                required
                autoComplete="new-password"
              />
            </div>
            {fieldErrors.password && (
              <p className="mt-1 text-sm text-red-600">
                {fieldErrors.password}
              </p>
            )}

            {/* Password strength indicators */}
            {password.length > 0 && (
              <div className="mt-2 space-y-1">
                {PASSWORD_RULES.map((rule) => (
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

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Confirm Password
            </label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <Input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="pl-10"
                placeholder="Confirm your password"
                required
                autoComplete="new-password"
              />
            </div>
            {fieldErrors.confirmPassword && (
              <p className="mt-1 text-sm text-red-600">
                {fieldErrors.confirmPassword}
              </p>
            )}
          </div>

          <Button
            type="submit"
            className="w-full"
            disabled={loading}
          >
            {loading ? "Creating account..." : "Create Account"}
          </Button>
        </form>

        <div className="mt-4 text-center">
          <span className="text-sm text-slate-500">
            Already have an account?{" "}
            <Link
              to="/login"
              className="text-primary-600 hover:text-primary-700 font-medium"
            >
              Sign in
            </Link>
          </span>
        </div>
      </div>
    </div>
  );
}
