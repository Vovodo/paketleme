import React, { useState } from 'react';
import {
  BellRing,
  CheckCircle2,
  KeyRound,
  Lock,
  LogOut,
  Save,
  Send,
  ShieldCheck,
} from 'lucide-react';
import { api } from '../api';
import { TelegramSettings } from '../types';

export const SettingsView: React.FC = () => {
  const [passwordInput, setPasswordInput] = useState('');
  const [unlockedPassword, setUnlockedPassword] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  const [settingsData, setSettingsData] = useState<TelegramSettings | null>(null);
  const [chatId, setChatId] = useState('');
  const [botToken, setBotToken] = useState('');

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null
  );

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setVerifying(true);

    try {
      const data = await api.verifyAdminSettings(passwordInput);
      setUnlockedPassword(passwordInput);
      setSettingsData(data);
      setChatId(data.telegram_chat_id || '');
      setBotToken('');
    } catch (err: any) {
      setAuthError(err.message || 'Yönetici şifresi doğrulanamadı.');
    } finally {
      setVerifying(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!unlockedPassword) return;

    setFeedback(null);
    setSaving(true);
    try {
      const updated = await api.updateTelegramSettings({
        password: unlockedPassword,
        telegram_chat_id: chatId.trim(),
        telegram_bot_token: botToken.trim() ? botToken.trim() : undefined,
      });
      setSettingsData(updated);
      setChatId(updated.telegram_chat_id);
      setBotToken('');
      setFeedback({
        type: 'success',
        text: 'Telegram bildirim ayarları başarıyla kaydedildi.',
      });
    } catch (err: any) {
      setFeedback({
        type: 'error',
        text: err.message || 'Ayarlar kaydedilemedi.',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleTestMessage = async () => {
    if (!unlockedPassword) return;
    setFeedback(null);
    setTesting(true);
    try {
      const res = await api.testTelegramSettings({
        password: unlockedPassword,
        telegram_chat_id: chatId.trim() || undefined,
        telegram_bot_token: botToken.trim() || undefined,
      });
      setFeedback({
        type: 'success',
        text: res.message,
      });
    } catch (err: any) {
      setFeedback({
        type: 'error',
        text: err.message || 'Test bildirimi gönderilemedi.',
      });
    } finally {
      setTesting(false);
    }
  };

  if (!unlockedPassword) {
    return (
      <div className="max-w-md mx-auto mt-8">
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 sm:p-8">
          <div className="w-12 h-12 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-center mb-4">
            <Lock className="w-6 h-6 text-blue-600" />
          </div>

          <h2 className="text-xl font-extrabold text-slate-900">Yönetici Ayarları</h2>
          <p className="text-sm text-slate-500 mt-1">
            Telegram bildirim grubu (Chat ID) ayarlarını düzenlemek için yönetici şifresini girin.
          </p>

          {authError && (
            <div className="mt-4 rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-xs font-semibold text-red-700">
              {authError}
            </div>
          )}

          <form onSubmit={handleUnlock} className="mt-5 space-y-4">
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1.5">
                Yönetici Şifresi
              </label>
              <div className="relative">
                <KeyRound className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="password"
                  autoFocus
                  required
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  placeholder="Şifreyi girin..."
                  className="w-full pl-10 pr-4 py-3 rounded-xl border border-slate-300 focus:border-blue-600 focus:ring-4 focus:ring-blue-100 text-sm font-semibold text-slate-900 outline-none transition"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={verifying || !passwordInput}
              className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white font-bold text-sm py-3 px-4 transition cursor-pointer"
            >
              <ShieldCheck className="w-4 h-4" />
              {verifying ? 'Doğrulanıyor...' : 'Ayarları Aç'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 sm:p-7">
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 pb-5 mb-6">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-center shrink-0">
              <BellRing className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <h2 className="text-lg font-extrabold text-slate-900">
                Telegram Depo Bildirim Ayarları
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Personel stok listesinden ürün talep ettiğinde bildirimler aşağıdaki Telegram
                grubuna iletilir.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              setUnlockedPassword(null);
              setPasswordInput('');
              setFeedback(null);
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-xs font-bold text-slate-700 cursor-pointer shrink-0"
          >
            <LogOut className="w-3.5 h-3.5" />
            Kilitle
          </button>
        </div>

        {feedback && (
          <div
            className={`mb-5 rounded-xl px-4 py-3 text-sm font-semibold flex items-center gap-2.5 border ${
              feedback.type === 'success'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                : 'bg-red-50 border-red-200 text-red-700'
            }`}
          >
            {feedback.type === 'success' && (
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            )}
            <span>{feedback.text}</span>
          </div>
        )}

        <form onSubmit={handleSave} className="space-y-5">
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1.5">
              Telegram Grup Chat ID
            </label>
            <input
              type="text"
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
              placeholder="Örn: -1001987654321"
              className="w-full rounded-xl border border-slate-300 focus:border-blue-600 focus:ring-4 focus:ring-blue-100 px-4 py-3 font-mono-code text-sm font-bold text-slate-900 outline-none transition"
            />
            <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">
              Grup Chat ID değerleri genellikle{' '}
              <code className="text-slate-800 font-semibold">-100...</code> veya{' '}
              <code className="text-slate-800 font-semibold">-...</code> ile başlar.{' '}
              <strong>İpucu:</strong> Bot Token&apos;ı kaydedip botu gruba/kanala ekledikten sonra
              sohbette <code className="bg-slate-100 px-1.5 py-0.5 rounded text-blue-700 font-bold">/id</code>{' '}
              yazarsanız, bot ilgili grubun Chat ID bilgisini otomatik olarak grupta paylaşır.
            </p>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-bold uppercase tracking-wider text-slate-700">
                Telegram Bot Token
              </label>
              {settingsData?.has_bot_token ? (
                <span className="text-[11px] font-mono-code text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded font-semibold">
                  Tanımlı: {settingsData.masked_bot_token}
                </span>
              ) : (
                <span className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded font-semibold">
                  Henüz Token Girilmedi
                </span>
              )}
            </div>
            <input
              type="password"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder={
                settingsData?.has_bot_token
                  ? 'Mevcut token korunur (değiştirmek için yeni token girin)'
                  : 'Örn: 7123456789:AAH...'
              }
              className="w-full rounded-xl border border-slate-300 focus:border-blue-600 focus:ring-4 focus:ring-blue-100 px-4 py-3 font-mono-code text-sm text-slate-900 outline-none transition"
            />
            <p className="text-xs text-slate-500 mt-1.5">
              @BotFather üzerinden aldığınız bot token&apos;ı buraya girebilir veya Coolify ortam
              değişkenlerinde <code className="text-slate-800 font-semibold">TELEGRAM_BOT_TOKEN</code>{' '}
              olarak tanımlayabilirsiniz. Botun gruba eklenmiş olduğundan emin olun.
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-100">
            <button
              type="button"
              disabled={testing || !chatId.trim()}
              onClick={handleTestMessage}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-50 text-slate-800 text-xs font-bold transition cursor-pointer"
            >
              <Send className="w-4 h-4 text-blue-600" />
              {testing ? 'Gönderiliyor...' : 'Gruba Test Bildirimi Gönder'}
            </button>

            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-sm font-bold shadow-sm transition cursor-pointer"
            >
              <Save className="w-4 h-4" />
              {saving ? 'Kaydediliyor...' : 'Ayarları Kaydet'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
