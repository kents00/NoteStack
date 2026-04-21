import React, { useEffect, useState } from 'react';
import { api } from '../services/api';
import { motion } from 'motion/react';
import { ArrowLeft, Check, Eye, EyeOff, Loader2, Sparkles, XCircle } from 'lucide-react';
import { NotificationInline } from './notifications/NotificationInline';
import { useNotifications } from '../context/NotificationContext';
import { buildAuthFailureNotification } from '../utils/authNotifications';

const AUTH_INLINE_SCOPE = 'auth-form';

interface AuthPagesProps {
  type: 'login' | 'signup';
  onNavigate: (view: 'landing' | 'login' | 'signup') => void;
  onAuthComplete: () => void;
}

export const AuthPages: React.FC<AuthPagesProps> = ({ type, onNavigate, onAuthComplete }) => {
  const [isLoading, setIsLoading] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const { inline: pushInline, clearInline, toast: pushToast } = useNotifications();

  const signupPasswordRequirements = [
    { key: 'length', label: 'At least 8 characters', valid: password.length >= 8 },
    { key: 'uppercase', label: 'At least 1 uppercase letter', valid: /[A-Z]/.test(password) },
    { key: 'lowercase', label: 'At least 1 lowercase letter', valid: /[a-z]/.test(password) },
    { key: 'number', label: 'At least 1 number', valid: /\d/.test(password) },
    { key: 'special', label: 'At least 1 special character', valid: /[^A-Za-z0-9]/.test(password) },
  ];

  const isSignupPasswordValid = signupPasswordRequirements.every((requirement) => requirement.valid);
  const isSignupPasswordConfirmed = password.length > 0 && password === confirmPassword;
  const isSignupSubmitBlocked =
    type === 'signup' && password.length > 0 && (!isSignupPasswordValid || !isSignupPasswordConfirmed);
  const firstNamePlaceholder = 'Enter your first name';
  const lastNamePlaceholder = 'Enter your last name';
  const emailPlaceholder = type === 'login' ? 'Enter your account email' : 'you@example.com';
  const passwordPlaceholder = type === 'login' ? 'Enter your password' : 'Use 8+ chars with Aa1!';
  const confirmPasswordPlaceholder = 'Re-enter your password';

  const showAuthError = (title: string, message: string) => {
    pushInline({
      scope: AUTH_INLINE_SCOPE,
      type: 'error',
      title,
      message,
    });
  };

  useEffect(() => {
    clearInline(AUTH_INLINE_SCOPE);
    setPassword('');
    setConfirmPassword('');
    setShowPassword(false);
    setShowConfirmPassword(false);
  }, [clearInline, type]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearInline(AUTH_INLINE_SCOPE);
    let accountCreated = false;

    // Validation
    if (!email || !password) {
      showAuthError('Missing Fields', 'Required fields are missing.');
      return;
    }

    if (type === 'signup') {
      if (!firstName || !lastName) {
        showAuthError('Name Required', 'First name and last name are required.');
        return;
      }
      if (!isSignupPasswordValid) {
        showAuthError('Weak Password', 'Password must satisfy all required parameters.');
        return;
      }
      if (!confirmPassword) {
        showAuthError('Confirm Password', 'Please confirm your password.');
        return;
      }
      if (password !== confirmPassword) {
        showAuthError('Password Mismatch', 'Passwords do not match.');
        return;
      }
    }

    setIsLoading(true);

    try {
      if (type === 'login') {
        const data = await api.login(email, password);
        localStorage.setItem('nb_auth_token', data.access_token);
        pushToast({
          type: 'success',
          title: 'Signed In',
          message: 'Welcome back. Redirecting to your workspace...',
          feature: 'auth',
          durationMs: 3500,
        });
      } else {
        await api.register({
          email,
          password,
          first_name: firstName,
          last_name: lastName
        });
        accountCreated = true;
        pushInline({
          scope: AUTH_INLINE_SCOPE,
          type: 'success',
          title: 'Account Created',
          message: 'Your account is ready. Signing you in...',
          autoClearMs: 2500,
        });

        // Auto-login after registration
        const data = await api.login(email, password);
        localStorage.setItem('nb_auth_token', data.access_token);
        pushToast({
          type: 'success',
          title: 'Account Ready',
          message: 'Your account was created successfully. Redirecting to your workspace...',
          feature: 'auth',
          durationMs: 3500,
        });
      }

      clearInline(AUTH_INLINE_SCOPE);
      onAuthComplete();
    } catch (err: any) {
      clearInline(AUTH_INLINE_SCOPE);

      const failure = buildAuthFailureNotification({
        mode: type,
        error: err,
        accountCreated,
      });
      showAuthError(failure.title, failure.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0A0A0B] text-slate-200 font-sans flex selection:bg-blue-500/30 w-full">

      {/* Left Branding Panel */}
      <div className="hidden lg:flex w-[45%] relative bg-[#050505] border-r border-[#1a1a1a] p-12 flex-col justify-between overflow-hidden">
        {/* Background Image & Ambient Effects */}
        <div className="absolute inset-0 z-0">
          <img
            src="https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?q=80&w=2564&auto=format&fit=crop"
            alt="NoteStack Abstract Background"
            className="w-full h-full object-cover opacity-20 sepia-[0.2] saturate-[0.5] mix-blend-screen"
            referrerPolicy="no-referrer"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-[#050505] via-[#050505]/60 to-transparent" />
          <div className="absolute inset-0 bg-gradient-to-r from-[#050505]/80 to-transparent" />
          <div className="absolute top-[-20%] left-[-10%] w-[80%] h-[80%] bg-blue-600/10 rounded-full blur-[140px] pointer-events-none mix-blend-screen" />
          <div className="absolute bottom-[-10%] right-[-10%] w-[60%] h-[60%] bg-indigo-600/5 rounded-full blur-[120px] pointer-events-none mix-blend-screen" />
        </div>

        {/* Brand Header */}
        <div className="relative z-10 flex items-center gap-3">
          <Sparkles className="w-6 h-6 text-blue-500" />
          <span className="text-2xl font-black text-white tracking-tighter">NoteStack</span>
        </div>

        {/* Feature/Quote */}
        <div className="relative z-10 max-w-sm mb-12">
          <blockquote className="text-3xl font-bold tracking-tight text-white leading-tight mb-6">
            "The ultimate sanctuary for your documents and thoughts."
          </blockquote>
          <p className="text-slate-400 text-lg">
            Connect multiple documents into a single unified knowledge base, fully private and highly focused.
          </p>
        </div>
      </div>

      {/* Right Auth Panel */}
      <div className="w-full lg:w-[55%] flex items-center justify-center p-6 sm:p-12 relative bg-[#0A0A0B]">
        {/* Mobile Brand (visible only on small screens) */}
        <div className="absolute top-6 left-6 flex lg:hidden items-center gap-2">
          <Sparkles className="w-5 h-5 text-blue-500" />
          <span className="text-xl font-bold tracking-tighter text-white">NoteStack</span>
        </div>

        {/* Back Button */}
        <button
          onClick={() => onNavigate('landing')}
          className="absolute top-6 right-6 flex items-center gap-2 px-3 py-1.5 text-[13px] font-medium text-slate-400 hover:text-white bg-[#131314] hover:bg-[#1e1e20] border border-[#2a2a2d] rounded-lg transition-all"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to website
        </button>

        {/* Auth Form Container */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className="w-full max-w-[380px]"
        >
          <div className="mb-10">
            <h2 className="text-3xl font-black text-white tracking-tighter mb-2">
              {type === 'login' ? 'Welcome back' : 'Create an account'}
            </h2>
            <p className="text-slate-400 text-[15px]">
              {type === 'login'
                ? 'Enter your details to access your workspace.'
                : 'Start organizing your research today.'}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {type === 'signup' && (
              <div className="flex flex-col sm:flex-row gap-4">
                <div className="flex-1 space-y-1.5">
                  <label className="text-[13px] font-medium text-slate-300">First Name</label>
                  <input
                    type="text"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    className="w-full bg-[#131314] border border-[#2a2a2d] rounded-xl py-3 px-4 text-[14px] text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all placeholder:text-slate-600 shadow-inner"
                    placeholder={firstNamePlaceholder}
                  />
                </div>
                <div className="flex-1 space-y-1.5">
                  <label className="text-[13px] font-medium text-slate-300">Last Name</label>
                  <input
                    type="text"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    className="w-full bg-[#131314] border border-[#2a2a2d] rounded-xl py-3 px-4 text-[14px] text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all placeholder:text-slate-600 shadow-inner"
                    placeholder={lastNamePlaceholder}
                  />
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-[13px] font-medium text-slate-300">Email Address</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full bg-[#131314] border border-[#2a2a2d] rounded-xl py-3 px-4 text-[14px] text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all placeholder:text-slate-600 shadow-inner"
                placeholder={emailPlaceholder}
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-[13px] font-medium text-slate-300">Password</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-[#131314] border border-[#2a2a2d] rounded-xl py-3 px-4 pr-11 text-[14px] text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all placeholder:text-slate-600 shadow-inner"
                  placeholder={passwordPlaceholder}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-200 transition-colors"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>

              {type === 'signup' && (
                <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                  {signupPasswordRequirements.map((requirement) => {
                    const hasPasswordInput = password.length > 0;
                    const textClass = hasPasswordInput
                      ? (requirement.valid ? 'text-emerald-400' : 'text-red-400')
                      : 'text-slate-500';

                    return (
                      <div key={requirement.key} className={`flex items-center gap-1.5 text-[12px] ${textClass}`}>
                        {requirement.valid
                          ? <Check className="w-3.5 h-3.5" />
                          : <XCircle className="w-3.5 h-3.5" />}
                        <span>{requirement.label}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {type === 'signup' && (
              <div className="space-y-1.5">
                <label className="text-[13px] font-medium text-slate-300">Confirm Password</label>
                <div className="relative">
                  <input
                    type={showConfirmPassword ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className={`w-full bg-[#131314] border rounded-xl py-3 px-4 pr-11 text-[14px] text-white focus:outline-none focus:ring-1 transition-all placeholder:text-slate-600 shadow-inner ${confirmPassword.length > 0 ? (isSignupPasswordConfirmed ? 'border-emerald-500/60 focus:border-emerald-500 focus:ring-emerald-500/30' : 'border-red-500/50 focus:border-red-500 focus:ring-red-500/30') : 'border-[#2a2a2d] focus:border-blue-500 focus:ring-blue-500'}`}
                    placeholder={confirmPasswordPlaceholder}
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPassword((prev) => !prev)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-200 transition-colors"
                    aria-label={showConfirmPassword ? 'Hide confirmation password' : 'Show confirmation password'}
                  >
                    {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                {confirmPassword.length > 0 && (
                  <p className={`text-[12px] font-medium ${isSignupPasswordConfirmed ? 'text-emerald-400' : 'text-red-400'}`}>
                    {isSignupPasswordConfirmed ? 'Passwords match.' : 'Passwords do not match.'}
                  </p>
                )}
              </div>
            )}

            <NotificationInline scope={AUTH_INLINE_SCOPE} className="mt-2" />

            <button
              type="submit"
              disabled={isLoading || isSignupSubmitBlocked}
              className="w-full bg-white text-black hover:bg-slate-200 font-bold text-[15px] py-3.5 rounded-xl transition-all shadow-lg shadow-white/5 disabled:opacity-50 disabled:cursor-not-allowed mt-4 flex items-center justify-center gap-2 active:scale-95"
            >
              {isLoading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                type === 'login' ? 'Sign In' : 'Create Account'
              )}
            </button>
          </form>

          <div className="mt-8 text-center">
            <p className="text-[14px] text-slate-400">
              {type === 'login' ? "Don't have an account? " : "Already have an account? "}
              <button
                onClick={() => onNavigate(type === 'login' ? 'signup' : 'login')}
                className="text-white hover:text-blue-400 font-semibold transition-colors focus:outline-none"
              >
                {type === 'login' ? 'Sign up' : 'Sign in'}
              </button>
            </p>
          </div>
        </motion.div>
      </div>
    </div>
  );
};

