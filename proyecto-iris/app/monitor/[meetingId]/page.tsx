import { redirect } from 'next/navigation'
import { getIrisUser } from '@/lib/iris-session'
import { IrisLiveMonitor } from '@/components/iris-live-monitor'

export default async function MonitorPage({ params }: { params: Promise<{ meetingId: string }> }) {
  const user = await getIrisUser()
  if (!user) redirect('/sign-in')
  const { meetingId } = await params
  return <IrisLiveMonitor meetingId={meetingId} />
}
