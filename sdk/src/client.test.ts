import { describe, expect, it } from 'vitest'
import { geoClientHeaders } from './client.js'

describe('geoClientHeaders', () => {
  it('sends the workspace API key', () => {
    expect(geoClientHeaders({ serviceUrl: 'http://localhost:4000', apiKey: 'geo_test' })).toEqual({
      'x-api-key': 'geo_test',
    })
  })

  it('adds x-workspace-id when a workspace id is configured', () => {
    expect(geoClientHeaders({
      serviceUrl: 'http://localhost:4000',
      apiKey: 'geo_test',
      workspaceId: 'ws-1',
    })).toEqual({
      'x-api-key': 'geo_test',
      'x-workspace-id': 'ws-1',
    })
  })
})
