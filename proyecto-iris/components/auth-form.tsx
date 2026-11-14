'use client'

import { FormEvent, useState } from 'react'
import { useRouter } from 'next/navigation'
import { authClient } from '@/lib/auth-client'

export function AuthForm({ mode }: { mode: 'sign-in' | 'sign-up' }) {
  const router = useRouter()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setPending(true)
    try {
      const result = mode === 'sign-up'
        ? await authClient.signUp.email({ name, email, password })
        : await authClient.signIn.email({ email, password })
      if (result.error) {
        setError('No se pudo completar el acceso. Comprueba los datos e inténtalo de nuevo.')
        return
      }
      // Force a fresh server request after Better Auth sets the session cookie.
      window.location.assign('/')
    } catch {
      setError('No se pudo completar el acceso. Comprueba los datos e inténtalo de nuevo.')
    } finally {
      setPending(false)
    }
  }

  return <form className="auth-form" onSubmit={submit}>
    {mode === 'sign-up' && <label>Nombre<input required value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" /></label>}
    <label>Email<input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" /></label>
    <label>Contraseña<input required minLength={8} type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'} /></label>
    {error && <p className="auth-error" role="alert">{error}</p>}
    <button className="primary-button auth-submit" disabled={pending}>{pending ? 'Procesando…' : mode === 'sign-up' ? 'Crear cuenta' : 'Iniciar sesión'}</button>
  </form>
}

