export type FileEditChangeType = 'created' | 'edited'

export interface FileEditContentBlock {
  type: 'file_edit'
  path: string
  changeType: FileEditChangeType
  addedLines: number
  removedLines: number
  diff: string
  truncated?: boolean
}
