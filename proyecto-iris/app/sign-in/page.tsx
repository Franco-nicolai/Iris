import Link from 'next/link'
import { AuthForm } from '@/components/auth-form'

export default function SignInPage() {
  return <main className="auth-shell"><section className="auth-card"><div className="brand-lockup"><div className="brand-mark">i</div><span>Iris</span></div><span className="eyebrow">ACCESO</span><h1>Vuelve a tu espacio de reuniones</h1><p>Inicia sesión para recuperar tus reuniones persistidas.</p><AuthForm mode="sign-in" /><p className="auth-switch">¿Aún no tienes cuenta? <Link href="/sign-up">Crear cuenta</Link></p></section></main>
}

