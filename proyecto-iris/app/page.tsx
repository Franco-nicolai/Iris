import { redirect } from 'next/navigation'
import { listUserMeetings } from '@/app/actions/iris'
import { getIrisUser } from '@/lib/iris-session'
import { IrisWorkspace } from '@/components/iris-workspace'

export default async function Page() {
  const user = await getIrisUser()
  if (!user) redirect('/sign-in')
  const meetings = await listUserMeetings()
  return <IrisWorkspace user={{ name: user.name, email: user.email }} meetings={meetings.map((meeting) => ({ ...meeting, startedAt: meeting.startedAt.toISOString(), endedAt: meeting.endedAt?.toISOString() ?? null, createdAt: meeting.createdAt.toISOString() }))} />
}

