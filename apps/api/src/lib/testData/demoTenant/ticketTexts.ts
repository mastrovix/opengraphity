/**
 * WHAT PEOPLE WRITE IN THE DEMO TENANT'S TICKETS (23 Sep 2026).
 *
 * Titles, descriptions, root causes and notes in the words an operations team
 * uses, tied to the kind of CI the ticket is about: an incident on a database
 * talks about a database. `{ci}` is replaced with the CI's name.
 */
import type { CILabel } from './cmdb.js'

export interface IncidentStory {
  /** Which trouble this is: the problems name their evidence by it (D19). */
  id: string
  category: 'hardware' | 'software' | 'network' | 'access' | 'security' | 'other'
  /**
   * The ways people write it (D17: six sentences covered a quarter of the
   * incidents, «Outlook keeps crashing» three times on the first page).
   */
  titles: string[]
  description: string
  rootCauses: string[]
  /** Probability weight among the stories of the same CI kind. */
  weight: number
  /** The change that removes the cause for good, when there is one (`CHANGE_STORIES` key). */
  fix?: string
}

export const INCIDENT_STORIES: Record<CILabel | 'portal', IncidentStory[]> = {
  Server: [
    { id: 'srv.cpu', category: 'hardware', weight: 4, fix: 'srv.capacity',
      titles: ['High CPU on {ci}', 'CPU at 100% on {ci}', '{ci} slow: CPU saturated', 'CPU saturation on {ci}'],
      description: 'Monitoring reports CPU above 95% on {ci} for more than 15 minutes. Services on the host respond slowly.',
      rootCauses: ['A runaway batch process consumed all CPU; the process was stopped and the job rescheduled outside business hours.', 'A scheduled antivirus scan overlapped with the nightly batch; the scan window was moved.', 'The host is undersized for the load it carries now; the batch was throttled until the capacity change.'] },
    { id: 'srv.memory', category: 'software', weight: 2, fix: 'srv.agent',
      titles: ['Memory exhausted on {ci}', '{ci} swapping heavily', 'Out of memory on {ci}'],
      description: 'Free memory on {ci} is below 2% and the host is swapping; processes are being killed.',
      rootCauses: ['A process leaking memory was restarted and a dump collected for the vendor.', 'The monitoring agent grew to 6 GB; it was restarted.'] },
    { id: 'srv.disk', category: 'hardware', weight: 3, fix: 'srv.logs',
      titles: ['Disk almost full on {ci}', '{ci}: data volume at 97%', 'No space left on {ci}', 'Filesystem full on {ci}'],
      description: 'The data volume on {ci} is at 97%. Applications writing logs may stop.',
      rootCauses: ['Log rotation was disabled after the last upgrade; rotation was re-enabled and old logs compressed.', 'A core dump filled the volume; it was archived and the volume extended by 50 GB.', 'Temporary export files were not cleaned up; a cleanup job was added.'] },
    { id: 'srv.down', category: 'hardware', weight: 2, fix: 'srv.firmware',
      titles: ['{ci} not responding', '{ci} is down', 'Cannot reach {ci}', '{ci} unreachable (ping and SSH)'],
      description: '{ci} does not answer to ping or SSH. Dependent services are unavailable.',
      rootCauses: ['The host hung after a kernel panic; it was rebooted and the kernel updated.', 'A failed power supply on the chassis; the PSU was replaced by the vendor.', 'The hypervisor host lost its storage path; the VM was migrated and restarted.'] },
    { id: 'srv.packet', category: 'network', weight: 2, fix: 'srv.nicdriver',
      titles: ['Packet loss to {ci}', 'Network timeouts towards {ci}', '{ci} drops connections'],
      description: 'Users report timeouts; monitoring shows 20% packet loss towards {ci}.',
      rootCauses: ['A duplex mismatch on the switch port; the port was set to auto-negotiation.', 'A faulty network cable in the rack; the cable was replaced.', 'The NIC driver was outdated; the driver was updated and the host restarted.'] },
    { id: 'srv.crash', category: 'software', weight: 2, fix: 'srv.patch',
      titles: ['Service crashed on {ci}', 'Main service stopped on {ci}', '{ci}: service does not restart'],
      description: 'The main service on {ci} stopped unexpectedly and does not restart automatically.',
      rootCauses: ['An expired service account password stopped the service; the password was rotated and stored in the vault.', 'A configuration change left an invalid parameter; the previous configuration was restored.', 'Out-of-memory kill of the service; the heap size was adjusted.'] },
  ],
  Application: [
    { id: 'app.500', category: 'software', weight: 5, fix: 'app.hotfix',
      titles: ['{ci} returns HTTP 500 errors', 'Internal server errors on {ci}', '{ci}: error 500 on save', 'Error pages from {ci}'],
      description: 'Users receive "Internal Server Error" from {ci} for a large share of requests.',
      rootCauses: ['A bad deployment introduced a null pointer in the order validation; the release was rolled back.', 'The connection pool to the database was exhausted; the pool size was increased and slow queries fixed.', 'A dependency API changed its contract; the client was updated.'] },
    { id: 'app.slow', category: 'software', weight: 4, fix: 'app.scale',
      titles: ['{ci} is very slow', 'Slow response times on {ci}', '{ci} takes minutes to load', 'Timeouts in {ci}'],
      description: 'Page load times of {ci} exceed 20 seconds; users cannot complete their work.',
      rootCauses: ['A missing index on a growing table; the index was created.', 'The cache cluster lost a node; the node was replaced and the cache warmed up.', 'An expensive report ran during peak hours; it was moved to the night.'] },
    { id: 'app.login', category: 'access', weight: 3, fix: 'app.sso',
      titles: ['Users cannot log in to {ci}', 'Login fails on {ci}', '{ci}: "invalid session" at login'],
      description: 'Login to {ci} fails with "invalid session" for several users.',
      rootCauses: ['The SSO certificate expired; a new certificate was installed.', 'A misconfigured group mapping after the directory sync; the mapping was fixed.', 'Session store unavailable; the service was restarted.'] },
    { id: 'app.batch', category: 'software', weight: 2, fix: 'app.batch',
      titles: ['Batch job failed in {ci}', 'Nightly batch of {ci} ended with errors', '{ci}: morning reports missing'],
      description: 'The nightly batch of {ci} ended with errors; the morning reports are missing.',
      rootCauses: ['Input file arrived late from the partner; the job was re-run.', 'A malformed record stopped the import; the record was corrected.', 'The job ran out of temporary space; the space was extended.'] },
    { id: 'app.branch', category: 'network', weight: 1,
      titles: ['{ci} unreachable from branch offices', 'Branches cannot open {ci}'],
      description: 'Branch users cannot reach {ci}; headquarters users can.',
      rootCauses: ['A firewall rule was removed during a cleanup; the rule was restored.', 'A routing change on the WAN; the route was corrected.'] },
  ],
  Database: [
    { id: 'db.slow', category: 'software', weight: 4, fix: 'db.index',
      titles: ['Slow queries on {ci}', 'Query timeouts on {ci}', '{ci}: reports run for minutes'],
      description: 'Queries on {ci} take several seconds; applications time out.',
      rootCauses: ['Statistics were stale after a large load; statistics were gathered.', 'A new query without an index; the index was added.', 'Lock contention from a long transaction; the transaction was killed and the code fixed.'] },
    { id: 'db.space', category: 'software', weight: 3, fix: 'db.purge',
      titles: ['Tablespace full on {ci}', 'Inserts failing on {ci}: no space', '{ci} out of space'],
      description: 'Inserts on {ci} fail because the tablespace is full.',
      rootCauses: ['Data growth above forecast; the tablespace was extended.', 'An audit table was never purged; a purge job was added.'] },
    { id: 'db.locks', category: 'software', weight: 2, fix: 'db.jobs',
      titles: ['Lock waits on {ci}', 'Deadlocks on {ci}', 'Blocked sessions on {ci}'],
      description: 'Sessions on {ci} wait on locks for minutes; the online transactions time out.',
      rootCauses: ['A batch update held locks during business hours; it was stopped and rescheduled.', 'A session left open by a failed job held the lock; it was killed.'] },
    { id: 'db.lag', category: 'software', weight: 2,
      titles: ['Replication lag on {ci}', 'Replica of {ci} behind by 30 minutes', 'Stale data from the replica of {ci}'],
      description: 'The replica of {ci} is more than 30 minutes behind; reports show old data.',
      rootCauses: ['A bulk update generated a burst of changes; replication caught up after throttling.', 'The replica host was undersized; it was resized.'] },
  ],
  DatabaseInstance: [
    { id: 'dbi.down', category: 'software', weight: 3, fix: 'dbi.archive',
      titles: ['Instance {ci} down', '{ci} not accepting connections', 'Database instance {ci} stopped'],
      description: 'The database instance {ci} is not accepting connections.',
      rootCauses: ['The instance stopped after the archive area filled up; archives were moved and the instance restarted.', 'A failed patch left the instance down; the patch was rolled back.'] },
    { id: 'dbi.io', category: 'hardware', weight: 2, fix: 'dbi.storage',
      titles: ['High I/O wait on {ci}', 'Storage latency on {ci}', '{ci}: every database slow'],
      description: 'I/O wait above 60% on {ci}; all its databases are slow.',
      rootCauses: ['A storage controller issue; the storage team failed over the controller.', 'Backup running during business hours; the backup window was corrected.'] },
    { id: 'dbi.memory', category: 'software', weight: 2, fix: 'dbi.memory',
      titles: ['Buffer cache pressure on {ci}', 'Low cache hit ratio on {ci}', '{ci}: physical reads spiking'],
      description: 'The buffer cache hit ratio of {ci} dropped below 80%; every query reads from disk.',
      rootCauses: ['A new database was added to the instance without resizing the memory; the heaviest reports were moved.', 'A full scan from an ad-hoc query flushed the cache; the query was stopped.'] },
    { id: 'dbi.logins', category: 'security', weight: 1,
      titles: ['Failed logins spike on {ci}', 'Brute-force attempts on {ci}'],
      description: 'Hundreds of failed logins per minute on {ci} from one address.',
      rootCauses: ['A decommissioned application still used an old password; it was switched off.', 'A brute-force attempt from the internal network; the source was isolated.'] },
  ],
  Certificate: [
    { id: 'cert.expiring', category: 'security', weight: 3, fix: 'cert.automate',
      titles: ['Certificate {ci} expiring', '{ci} expires in less than 10 days', 'Renewal needed for {ci}'],
      description: 'The certificate {ci} expires in less than 10 days.',
      rootCauses: ['The renewal reminder went to a former owner; the certificate was renewed and the owner updated.', 'Automatic renewal failed on DNS validation; the record was fixed and the certificate renewed.'] },
    { id: 'cert.chain', category: 'security', weight: 2, fix: 'cert.chain',
      titles: ['Certificate error on {ci}', 'Clients reject {ci}: incomplete chain', 'TLS warning for {ci}'],
      description: 'Clients reject the certificate {ci}: incomplete chain.',
      rootCauses: ['The intermediate certificate was missing after the renewal; the full chain was installed.'] },
  ],
  BusinessApplication: [],
  BusinessCapability: [],
  portal: [
    { id: 'portal.laptop', category: 'hardware', weight: 4,
      titles: ['My laptop does not start', "Laptop won't turn on", 'Laptop dead after the weekend', 'My notebook does not boot', 'Black screen on my laptop'],
      description: 'My laptop does not turn on, not even when plugged in.',
      rootCauses: ['The battery was faulty; the laptop was swapped.', 'The power adapter was broken; a new adapter was delivered.'] },
    { id: 'portal.outlook', category: 'software', weight: 4,
      titles: ['Outlook keeps crashing', 'Outlook closes by itself', 'E-mail client crashes on startup', 'Outlook freezes when I open an attachment', 'Cannot open Outlook'],
      description: 'Outlook closes by itself a few seconds after opening.',
      rootCauses: ['A corrupted profile; the profile was recreated.', 'A faulty add-in; the add-in was disabled.'] },
    { id: 'portal.drive', category: 'access', weight: 4,
      titles: ['I cannot access the shared drive', 'Access denied on the team folder', 'Shared folder not visible anymore', 'Cannot open files on the S: drive', 'Lost access to the project share'],
      description: 'I get "access denied" on the team shared drive since this morning.',
      rootCauses: ['The user was missing from the security group after a team change; membership was restored.', 'An expired password on the cached credentials; the user was guided to update them.'] },
    { id: 'portal.wifi', category: 'network', weight: 3,
      titles: ['Wi-Fi keeps disconnecting', 'Wi-Fi drops every few minutes', 'No Wi-Fi on my floor', 'Cannot connect to the office Wi-Fi'],
      description: 'The office Wi-Fi drops every few minutes on my laptop.',
      rootCauses: ['An outdated Wi-Fi driver; the driver was updated.', 'Interference on the floor access point; the channel was changed.'] },
    { id: 'portal.printer', category: 'other', weight: 3,
      titles: ['Printer on my floor does not print', 'Print jobs stuck in the queue', 'Printer shows a paper jam that is not there', 'Cannot print to the colour printer'],
      description: 'Jobs stay in the queue and nothing is printed.',
      rootCauses: ['The print spooler hung; it was restarted.', 'The printer was out of toner; the toner was replaced.'] },
    { id: 'portal.vpn', category: 'network', weight: 3,
      titles: ['VPN does not connect', 'VPN disconnects every hour', 'Cannot reach the intranet from home', 'VPN client shows error 809'],
      description: 'The VPN client fails to connect from home; I cannot reach the internal applications.',
      rootCauses: ['The VPN client was outdated; it was updated to the supported version.', 'The home router blocked the VPN protocol; the user was moved to the SSL profile.'] },
    { id: 'portal.account', category: 'access', weight: 4,
      titles: ['My account is locked', 'Password expired and I cannot change it', 'Cannot log in after the holidays', 'MFA prompt never arrives'],
      description: 'I cannot log in to my computer or to the portal since this morning.',
      rootCauses: ['The account was locked by an old password saved on the phone; it was unlocked and the phone updated.', 'The MFA method was tied to the old phone; it was re-registered.'] },
    { id: 'portal.meetings', category: 'software', weight: 3,
      titles: ['Teams calls drop', 'No audio in video meetings', 'Camera not working in meetings', 'Screen sharing does not work'],
      description: 'Video calls drop after a few minutes and nobody hears me.',
      rootCauses: ['The headset driver conflicted with the meeting client; the driver was updated.', 'The client cache was corrupted; it was cleared and the client reinstalled.'] },
    { id: 'portal.excel', category: 'software', weight: 2,
      titles: ['Excel freezes with large files', 'Excel macro stopped working', 'Excel crashes when opening a report'],
      description: 'Excel stops responding when I open the monthly report.',
      rootCauses: ['The 32-bit version could not open the file; the 64-bit version was installed.', 'The macro was blocked by the new security policy; it was signed and trusted.'] },
    { id: 'portal.screen', category: 'hardware', weight: 3,
      titles: ['Second monitor not detected', 'Docking station does not work', 'External screen flickers', 'USB-C dock not recognised'],
      description: 'My external monitor stays black when the laptop is on the docking station.',
      rootCauses: ['The dock firmware was outdated; it was updated.', 'A faulty display cable; the cable was replaced.'] },
    { id: 'portal.phone', category: 'hardware', weight: 2,
      titles: ['Company phone does not sync e-mail', 'Authenticator app lost after phone change', 'Mobile phone cannot join the company Wi-Fi'],
      description: 'My company phone stopped receiving e-mails yesterday.',
      rootCauses: ['The device certificate expired; the phone was re-enrolled.', 'The mail profile was removed by the last update; it was pushed again.'] },
    { id: 'portal.app', category: 'software', weight: 3,
      titles: ['Expense app shows an error', 'Cannot submit my timesheet', 'HR portal does not load', 'Intranet search returns nothing'],
      description: 'The page shows an error when I try to save.',
      rootCauses: ['A browser extension blocked the page scripts; it was disabled.', 'The user profile was missing a role after the reorganisation; it was added.'] },
    { id: 'portal.phishing', category: 'security', weight: 1,
      titles: ['I clicked on a suspicious link', 'I entered my password on a fake page', 'Suspicious e-mail asked for my password'],
      description: 'I opened a link in an e-mail that looked like our intranet and entered my password.',
      rootCauses: ['The password was reset, sessions revoked and the phishing domain blocked.'] },
  ],
}

export const PENDING_NOTES: readonly string[] = [
  'Waiting for the vendor to confirm the replacement part.',
  'Waiting for the user to confirm the issue is still present.',
  'Waiting for the maintenance window agreed with the business.',
  'Waiting for the network provider to check their side.',
  'Waiting for logs from the application team.',
]

export const WORK_COMMENTS: readonly string[] = [
  'Checked the monitoring dashboards: the issue started at the time reported.',
  'Logs collected and attached to the investigation notes.',
  'Workaround applied, monitoring the situation.',
  'Contacted the application owner to agree on the next steps.',
  'Reproduced the problem in the test environment.',
  'Escalated internally to the second-level team for analysis.',
  'The user confirmed the service works again.',
]

export const REQUESTER_COMMENTS: readonly string[] = [
  'Any update on this? It is blocking my work.',
  'The problem happened again this morning.',
  'Thank you, it works now.',
  'I can be reached on my mobile if you need more details.',
]

/**
 * A PROBLEM IS ONE CAUSE BEHIND ITS INCIDENTS (tour of 23 Sep 2026, D19).
 *
 * «Repeated disk-full events» was linked to «Packet loss» and «High CPU»
 * incidents, and resolved by «Upgrade the monitoring agent»: the story was
 * drawn by CI type, not by cause. Each story now names the incidents that are
 * its evidence (`symptoms`, keys of `INCIDENT_STORIES`) and the change that
 * removes the cause (`fix`, a key of `CHANGE_STORIES`); and there are more of
 * them — seven stories for eight hundred problems made every list repeat.
 */
export interface ProblemStory {
  id: string
  /** The category the problem is filed under (D20: the form offers it). */
  category: 'hardware' | 'software' | 'network' | 'access' | 'security' | 'other'
  title: string
  description: string
  workaround: string
  rootCause: string
  symptoms: string[]
  fix: string
}

export const PROBLEM_STORIES: Record<CILabel, ProblemStory[]> = {
  Server: [
    { id: 'srv.p.memleak', category: 'software', symptoms: ['srv.memory', 'srv.crash'], fix: 'srv.agent',
      title: 'Recurring memory exhaustion on {ci}', description: 'Several incidents in the last weeks were caused by memory exhaustion on {ci}.',
      workaround: 'Restart the affected service when memory usage exceeds 90%.', rootCause: 'A memory leak in the monitoring agent version installed on the host.' },
    { id: 'srv.p.disk', category: 'software', symptoms: ['srv.disk'], fix: 'srv.logs',
      title: 'Repeated disk-full events on {ci}', description: 'The data volume of {ci} fills up every few weeks.',
      workaround: 'Compress and move old logs manually.', rootCause: 'Log retention configured at 365 days instead of 30.' },
    { id: 'srv.p.hang', category: 'hardware', symptoms: ['srv.down'], fix: 'srv.firmware',
      title: 'Unexplained hangs of {ci}', description: '{ci} stopped answering several times, each time under heavy I/O.',
      workaround: 'Reboot the host from the management console and move its workloads.', rootCause: 'A known firmware defect of the storage controller freezes the host under heavy I/O.' },
    { id: 'srv.p.network', category: 'network', symptoms: ['srv.packet'], fix: 'srv.nicdriver',
      title: 'Intermittent packet loss on {ci}', description: 'Packet loss towards {ci} comes back every few days and lasts minutes.',
      workaround: 'Disable TCP offload on the interface.', rootCause: 'The network driver shipped with the image has a defect with the switch firmware in use.' },
    { id: 'srv.p.capacity', category: 'hardware', symptoms: ['srv.cpu'], fix: 'srv.capacity',
      title: 'CPU capacity of {ci} no longer enough', description: 'CPU saturation on {ci} is now weekly: the load grew, the host did not.',
      workaround: 'Throttle the batch jobs during business hours.', rootCause: 'The host was sized three years ago for half of the load it carries today.' },
  ],
  Application: [
    { id: 'app.p.race', category: 'software', symptoms: ['app.500'], fix: 'app.hotfix',
      title: 'Intermittent HTTP 500 errors in {ci}', description: 'Users report sporadic errors in {ci}; several incidents were opened.',
      workaround: 'Recycle the application pool when the error rate rises.', rootCause: 'A race condition in the session handling under high load.' },
    { id: 'app.p.monthend', category: 'software', symptoms: ['app.slow'], fix: 'app.scale',
      title: 'Performance degradation of {ci} at month-end', description: 'Every month-end {ci} becomes very slow.',
      workaround: 'Postpone the routine reports during month-end.', rootCause: 'The month-end load needs twice the nodes the application runs on.' },
    { id: 'app.p.pool', category: 'software', symptoms: ['app.500', 'app.slow'], fix: 'app.pool',
      title: 'Connection pool exhaustion in {ci}', description: '{ci} runs out of database connections at peak, then errors and slowness follow.',
      workaround: 'Restart the service when the active connections exceed 90%.', rootCause: 'Connections leak on the error path, and the pool is sized for half of the peak.' },
    { id: 'app.p.sso', category: 'access', symptoms: ['app.login'], fix: 'app.sso',
      title: 'Login failures on {ci} after every certificate change', description: 'Each rotation of the SSO certificate locks the users out of {ci}.',
      workaround: 'Update the pinned certificate by hand after each change.', rootCause: 'The SSO signing certificate is pinned in the application configuration.' },
    { id: 'app.p.batch', category: 'software', symptoms: ['app.batch'], fix: 'app.batch',
      title: 'Nightly batch of {ci} fails when the partner file is late', description: 'The nightly batch of {ci} fails every time the partner file arrives after 02:00.',
      workaround: 'Re-run the batch by hand after the file arrives.', rootCause: 'The batch starts at a fixed hour instead of waiting for the partner file.' },
  ],
  Database: [
    { id: 'db.p.locks', category: 'software', symptoms: ['db.locks', 'db.slow'], fix: 'db.jobs',
      title: 'Recurring lock contention on {ci}', description: 'Lock waits on {ci} cause application timeouts several times a week.',
      workaround: 'Kill the blocking sessions after 5 minutes.', rootCause: 'A batch job updates rows in a different order than the online transactions.' },
    { id: 'db.p.growth', category: 'software', symptoms: ['db.space'], fix: 'db.purge',
      title: 'Uncontrolled growth of {ci}', description: 'The tablespace of {ci} fills up every month.',
      workaround: 'Extend the tablespace when it passes 90%.', rootCause: 'The audit tables were never purged and no retention was ever defined.' },
    { id: 'db.p.plans', category: 'software', symptoms: ['db.slow'], fix: 'db.index',
      title: 'Unstable query plans on {ci}', description: 'The same queries on {ci} are fast one day and time out the next.',
      workaround: 'Gather statistics after each load.', rootCause: 'Missing indexes and stale statistics after the monthly loads.' },
    { id: 'db.p.history', category: 'software', symptoms: ['db.slow'], fix: 'db.partition',
      title: 'Reports on {ci} slower every month', description: 'Every month the reports on {ci} take longer.',
      workaround: 'Run the heavy reports at night.', rootCause: 'The largest tables are not partitioned and every report scans years of history.' },
  ],
  DatabaseInstance: [
    { id: 'dbi.p.archive', category: 'software', symptoms: ['dbi.down'], fix: 'dbi.archive',
      title: 'Archive area fills up on {ci}', description: 'The archive area of {ci} fills up and stops the instance.',
      workaround: 'Move archives to the backup area manually.', rootCause: 'The archive backup job fails silently when the backup server is busy.' },
    { id: 'dbi.p.io', category: 'hardware', symptoms: ['dbi.io'], fix: 'dbi.storage',
      title: 'Storage too slow for {ci}', description: 'I/O wait on {ci} rises every afternoon and slows all its databases.',
      workaround: 'Move the backups outside business hours.', rootCause: 'The instance was placed on the capacity tier of the storage array.' },
    { id: 'dbi.p.memory', category: 'software', symptoms: ['dbi.memory', 'dbi.io'], fix: 'dbi.memory',
      title: 'Memory of {ci} below what its databases need', description: 'The cache of {ci} cannot hold the working set of its databases any more.',
      workaround: 'Stop the heaviest ad-hoc sessions at peak.', rootCause: 'The buffer cache was sized for half of the databases the instance now hosts.' },
  ],
  Certificate: [
    { id: 'cert.p.late', category: 'security', symptoms: ['cert.expiring'], fix: 'cert.automate',
      title: 'Certificates renewed too late', description: 'Certificates such as {ci} were renewed only after users saw errors.',
      workaround: 'Weekly manual check of the expiring certificates.', rootCause: 'Renewal reminders are sent to individual owners instead of a team mailbox.' },
    { id: 'cert.p.chain', category: 'security', symptoms: ['cert.chain'], fix: 'cert.chain',
      title: 'Renewed certificates installed without their chain', description: 'After renewals such as {ci}, clients reject the certificate.',
      workaround: 'Install the intermediate by hand after each renewal.', rootCause: 'The renewal procedure installs only the leaf certificate.' },
  ],
  BusinessApplication: [],
  BusinessCapability: [],
}

export interface ChangeStory { id: string; title: string; why: string; what: string; steps: string[] }

/**
 * The changes, by CI type (D32: «Monthly OS patching» of an application came
 * from a conflict that put another CI first, see changes.ts).
 */
export const CHANGE_STORIES: Record<CILabel, ChangeStory[]> = {
  Server: [
    { id: 'srv.patch', title: 'Monthly OS patching of {ci}', why: 'Security patches released this month must be applied within 30 days.', what: 'Apply the monthly OS patches to {ci} and reboot.', steps: ['Snapshot the host', 'Install the patches', 'Reboot and verify the services'] },
    { id: 'srv.capacity', title: 'Add CPU and memory to {ci}', why: 'CPU and memory usage on {ci} are above 85% at peak.', what: 'Add 4 vCPU and 16 GB of RAM to {ci}.', steps: ['Shut down the host', 'Resize the VM', 'Start and verify'] },
    { id: 'srv.agent', title: 'Upgrade the monitoring agent on {ci}', why: 'The current agent version has a known memory leak.', what: 'Upgrade the monitoring agent on {ci} to the latest release.', steps: ['Stop the old agent', 'Install the new agent', 'Check the metrics'] },
    { id: 'srv.logs', title: 'Configure log rotation on {ci}', why: 'The data volume of {ci} fills up with logs kept for a year.', what: 'Set a 30-day log retention and nightly compression on {ci}.', steps: ['Change the rotation policy', 'Compress the old logs', 'Check the free space'] },
    { id: 'srv.firmware', title: 'Update the firmware of {ci}', why: 'The vendor fixed the storage controller defect that freezes the host.', what: 'Install the new controller firmware on {ci}.', steps: ['Move the workloads', 'Flash the firmware', 'Reboot and run the checks'] },
    { id: 'srv.nicdriver', title: 'Update the network driver of {ci}', why: 'The current driver drops packets with the switch firmware in use.', what: 'Install the certified network driver on {ci}.', steps: ['Install the driver', 'Restart the interface', 'Run the network checks'] },
  ],
  Application: [
    { id: 'app.release', title: 'Release a new version of {ci}', why: 'The business asked for the new features planned in this release.', what: 'Deploy the new release of {ci}.', steps: ['Deploy to the servers', 'Run the smoke tests', 'Open to the users'] },
    { id: 'app.hotfix', title: 'Deploy a hotfix of {ci}', why: 'A defect of {ci} causes errors for the users.', what: 'Deploy the hotfix that corrects the defect in {ci}.', steps: ['Deploy the hotfix', 'Run the regression tests', 'Watch the error rate'] },
    { id: 'app.tls', title: 'Renew the TLS configuration of {ci}', why: 'Old TLS versions must be disabled by policy.', what: 'Disable TLS 1.0 and 1.1 on {ci}.', steps: ['Change the configuration', 'Restart the service', 'Test the clients'] },
    { id: 'app.scale', title: 'Scale out {ci}', why: 'Traffic grew 40% this year and response times are rising.', what: 'Add an application node to {ci}.', steps: ['Provision the node', 'Add it to the load balancer', 'Verify the traffic split'] },
    { id: 'app.pool', title: 'Tune the connection pool of {ci}', why: '{ci} runs out of database connections at peak.', what: 'Fix the connection leak and size the pool of {ci} for the peak.', steps: ['Deploy the configuration', 'Restart the nodes one by one', 'Watch the pool usage'] },
    { id: 'app.sso', title: 'Stop pinning the SSO certificate in {ci}', why: 'Every rotation of the SSO certificate locks the users out of {ci}.', what: 'Read the SSO signing keys from the identity provider metadata in {ci}.', steps: ['Change the configuration', 'Restart the service', 'Test the login'] },
    { id: 'app.batch', title: 'Trigger the batch of {ci} on file arrival', why: 'The batch of {ci} fails whenever the partner file is late.', what: 'Start the batch of {ci} when the partner file arrives, not at a fixed hour.', steps: ['Change the scheduler', 'Test with a late file', 'Monitor the next run'] },
  ],
  Database: [
    { id: 'db.index', title: 'Add indexes to {ci}', why: 'Slow queries on {ci} caused several incidents.', what: 'Create the indexes recommended by the analysis on {ci}.', steps: ['Create the indexes online', 'Gather statistics', 'Check the query plans'] },
    { id: 'db.purge', title: 'Purge old data from {ci}', why: 'Data older than the retention period must be removed.', what: 'Purge the records older than 7 years from {ci}.', steps: ['Back up the tables', 'Run the purge', 'Rebuild the indexes'] },
    { id: 'db.partition', title: 'Partition the large tables of {ci}', why: 'Reports on {ci} scan years of history.', what: 'Partition the three largest tables of {ci} by month.', steps: ['Create the partitioned tables', 'Move the data', 'Switch and verify'] },
    { id: 'db.jobs', title: 'Reorder the batch updates on {ci}', why: 'The batch and the online transactions lock each other on {ci}.', what: 'Change the batch on {ci} to update rows in the same order as the online transactions.', steps: ['Deploy the new batch', 'Run it in the test window', 'Watch the lock waits'] },
  ],
  DatabaseInstance: [
    { id: 'dbi.patch', title: 'Apply the quarterly patch to {ci}', why: 'The vendor released the quarterly security update.', what: 'Patch the database instance {ci}.', steps: ['Stop the instance', 'Apply the patch', 'Start and validate'] },
    { id: 'dbi.memory', title: 'Resize the memory of {ci}', why: 'The buffer cache hit ratio of {ci} is below target.', what: 'Increase the memory of {ci}.', steps: ['Change the parameters', 'Restart the instance', 'Monitor the hit ratio'] },
    { id: 'dbi.archive', title: 'Fix the archive backup of {ci}', why: 'The archive area of {ci} fills up when the backup job fails.', what: 'Make the archive backup of {ci} retry and alert on failure.', steps: ['Change the backup job', 'Test a failure', 'Check the archive area'] },
    { id: 'dbi.storage', title: 'Move {ci} to the performance storage tier', why: 'I/O wait on {ci} slows all its databases.', what: 'Migrate the volumes of {ci} to the performance tier.', steps: ['Copy the volumes', 'Switch the instance', 'Check the I/O latency'] },
  ],
  Certificate: [
    { id: 'cert.renew', title: 'Renew certificate {ci}', why: 'The certificate {ci} is about to expire.', what: 'Install the renewed certificate {ci}.', steps: ['Install the new certificate', 'Restart the listeners', 'Verify the chain'] },
    { id: 'cert.chain', title: 'Install the full chain of {ci}', why: 'Clients reject {ci} because the intermediate is missing.', what: 'Install the certificate {ci} with its intermediate chain.', steps: ['Install the chain', 'Restart the listeners', 'Test from the clients'] },
    { id: 'cert.automate', title: 'Automate the renewal of {ci}', why: 'Certificates like {ci} were renewed only after they expired.', what: 'Move {ci} to the automatic renewal service with alerts to the team mailbox.', steps: ['Enrol the certificate', 'Test a renewal', 'Update the owner mailbox'] },
  ],
  BusinessApplication: [],
  BusinessCapability: [],
}

/** A change story by its key (the fix a problem or an incident names). */
export function changeStoryByKey(key: string): ChangeStory {
  for (const list of Object.values(CHANGE_STORIES)) {
    const story = list.find((s) => s.id === key)
    if (story) return story
  }
  throw new Error(`ticketTexts: no change story "${key}"`)
}

export function fill(template: string, ci: string): string {
  return template.replace(/\{ci\}/g, ci)
}
