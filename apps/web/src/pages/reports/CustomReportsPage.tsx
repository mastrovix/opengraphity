import { useCustomReports } from './useCustomReports'
import { ReportListView } from './ReportListView'
import { ReportDetailView } from './ReportDetailView'
import { ReportScheduleSettings } from './ReportScheduleSettings'

export function CustomReportsPage() {
  const h = useCustomReports()

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#f8fafc' }}>

      {h.view === 'list' && (
        <ReportListView
          templates={h.templates} teams={h.teams}
          menuRef={h.menuRef} menuOpenId={h.menuOpenId} setMenuOpenId={h.setMenuOpenId}
          showNewDialog={h.showNewDialog} setShowNewDialog={h.setShowNewDialog}
          newName={h.newName} setNewName={h.setNewName}
          newDesc={h.newDesc} setNewDesc={h.setNewDesc}
          newVis={h.newVis} setNewVis={h.setNewVis}
          newTeamIds={h.newTeamIds} setNewTeamIds={h.setNewTeamIds}
          creating={h.creating}
          goToDetail={h.goToDetail}
          handleExecuteAndGoToDetail={h.handleExecuteAndGoToDetail}
          openSettings={h.openSettings}
          duplicateTemplate={h.duplicateTemplate}
          handleDeleteTemplate={h.handleDeleteTemplate}
          handleCreateTemplate={h.handleCreateTemplate}
          resetNew={h.resetNew}
        />
      )}

      {(h.view === 'detail' || h.view === 'add-section' || h.view === 'edit-section') && h.selected && (
        <ReportDetailView
          view={h.view}
          selected={h.selected}
          editSection={h.editSection}
          sectionResults={h.sectionResults}
          execLoading={h.execLoading}
          exportingPDF={h.exportingPDF}
          exportingExcel={h.exportingExcel}
          setView={h.setView}
          openSettings={h.openSettings}
          handleAddSection={h.handleAddSection}
          handleUpdateSection={h.handleUpdateSection}
          handleRemoveSection={h.handleRemoveSection}
          startEditSection={h.startEditSection}
          cancelEditSection={h.cancelEditSection}
          sectionToInput={h.sectionToInput}
          handleExecuteSelected={h.handleExecuteSelected}
          handleExportPDF={h.handleExportPDF}
          handleExportExcel={h.handleExportExcel}
        />
      )}

      {h.view === 'settings' && h.selected && (
        <ReportScheduleSettings
          selected={h.selected} teams={h.teams} channels={h.channels} updating={h.updating}
          settingsName={h.settingsName} setSettingsName={h.setSettingsName}
          settingsDesc={h.settingsDesc} setSettingsDesc={h.setSettingsDesc}
          settingsVis={h.settingsVis} setSettingsVis={h.setSettingsVis}
          settingsTeamIds={h.settingsTeamIds} setSettingsTeamIds={h.setSettingsTeamIds}
          settingsSched={h.settingsSched} setSettingsSched={h.setSettingsSched}
          settingsSchedCron={h.settingsSchedCron} setSettingsSchedCron={h.setSettingsSchedCron}
          settingsChanId={h.settingsChanId} setSettingsChanId={h.setSettingsChanId}
          settingsRecipients={h.settingsRecipients} setSettingsRecipients={h.setSettingsRecipients}
          recipientInput={h.recipientInput} setRecipientInput={h.setRecipientInput}
          settingsFormat={h.settingsFormat} setSettingsFormat={h.setSettingsFormat}
          schedulePreset={h.schedulePreset} setSchedulePreset={h.setSchedulePreset}
          customCron={h.customCron} setCustomCron={h.setCustomCron}
          handleSaveSettings={h.handleSaveSettings}
          setView={h.setView}
        />
      )}
    </div>
  )
}
