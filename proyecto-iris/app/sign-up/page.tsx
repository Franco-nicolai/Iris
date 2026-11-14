import Link from 'next/link'
import { AuthForm } from '@/components/auth-form'

export default function SignUpPage() {
  return <main className="auth-shell"><section className="auth-card"><div className="brand-lockup"><div className="brand-mark">i</div><span>Iris</span></div><span className="eyebrow">NUEVA CUENTA</span><h1>Prepara tu espacio de Iris</h1><p>Tu historial quedará aislado en tu cuenta.</p><AuthForm mode="sign-up" /><p className="auth-switch">¿Ya tienes cuenta? <Link href="/sign-in">Iniciar sesión</Link></p></section></main>
}

