import { HttpClient, HttpClientRequestOptions, defaultHttpClient } from '../transaction/http/index.js'
import { Transaction } from '../transaction/index.js'
import OverlayAdminTokenTemplate from './OverlayAdminTokenTemplate.js'

/**
 * The question asked to the Overlay Services Engine when a consumer of state wishes to look up information.
 */
export interface LookupQuestion {
  /**
     * The identifier for a Lookup Service which the person asking the question wishes to use.
     */
  service: string

  /**
     * The query which will be forwarded to the Lookup Service.
     * Its type depends on that prescribed by the Lookup Service employed.
     */
  query: unknown
}

/**
 * How the Overlay Services Engine responds to a Lookup Question.
 * It may comprise either an output list or a freeform response from the Lookup Service.
 */
export type LookupAnswer = {
  type: 'output-list'
  outputs: Array<{
    beef: number[]
    outputIndex: number
  }>
} | {
  type: 'freeform'
  result: unknown
}

/** Default SLAP trackers */
export const DEFAULT_SLAP_TRACKERS: string[] = [
  // TODO: Specify default trackers.
]

/** Configuration options for the Lookup resolver. */
export interface LookupResolverConfig {
  /** The facilitator used to make requests to Overlay Services hosts. */
  facilitator?: OverlayLookupFacilitator
  /** The list of SLAP trackers queried to resolve Overlay Services hosts for a given lookup service. */
  slapTrackers?: string[]
  /** Map of lookup service names to arrays of hosts to use in place of resolving via SLAP. */
  hostOverrides?: Record<string, string[]>
  /** Map of lookup service names to arrays of hosts to use in addition to resolving via SLAP. */
  additionalHosts?: Record<string, string[]>
}

/** Facilitates lookups to URLs that return answers. */
export interface OverlayLookupFacilitator {
  lookup: (url: string, question: LookupQuestion) => Promise<LookupAnswer>
}

export class HTTPSOverlayLookupFacilitator implements OverlayLookupFacilitator {
  httpClient: HttpClient

  constructor(httpClient?: HttpClient) {
    this.httpClient = httpClient ?? defaultHttpClient()
  }

  async lookup(url: string, question: LookupQuestion): Promise<LookupAnswer> {
    if (!url.startsWith('https:')) {
      throw new Error('HTTPS facilitator can only use URLs that start with "https:"')
    }
    const requestOptions: HttpClientRequestOptions = {
      method: 'POST',
      data: JSON.stringify({ service: question.service, query: question.query })
    }
    const response = await this.httpClient.request<LookupAnswer>(`${url}/lookup`, requestOptions)
    if (response.ok) {
      return response.data
    } else {
      throw new Error('Failed to facilitate lookup')
    }
  }
}

/**
 * Represents an SHIP transaction broadcaster.
 */
export default class LookupResolver {
  private readonly facilitator: OverlayLookupFacilitator
  private readonly slapTrackers: string[]
  private readonly hostOverrides: Record<string, string[]>
  private readonly additionalHosts: Record<string, string[]>

  constructor(config?: LookupResolverConfig) {
    const { facilitator, slapTrackers, hostOverrides, additionalHosts } = config ?? {} as LookupResolverConfig
    this.facilitator = facilitator ?? new HTTPSOverlayLookupFacilitator()
    this.slapTrackers = slapTrackers ?? DEFAULT_SLAP_TRACKERS
    this.hostOverrides = hostOverrides ?? {}
    this.additionalHosts = additionalHosts ?? {}
  }

  /**
   * Given a LookupQuestion, returns a LookupAnswer. Aggregates across multiple services and supports resiliency.
   */
  async query(question: LookupQuestion): Promise<LookupAnswer> {
    let competentHosts: string[] = []
    if (question.service === 'ls_slap') {
      competentHosts = this.slapTrackers
    } else if (this.hostOverrides[question.service]) {
      competentHosts = this.hostOverrides[question.service]
    } else {
      competentHosts = await this.findCompetentHosts(question.service)
    }
    if (this.additionalHosts[question.service]) {
      competentHosts = [
        ...competentHosts,
        ...this.additionalHosts[question.service]
      ]
    }
    if (competentHosts.length < 1) {
      throw new Error(`No competent hosts found by the SLAP trackers for lookup service: ${question.service}`)
    }

    // Use Promise.allSettled to handle individual host failures
    const hostResponses = await Promise.allSettled(
      competentHosts.map(async host => await this.facilitator.lookup(host, question))
    )

    const successfulResponses = hostResponses
      .filter(result => result.status === 'fulfilled')
      .map(result => (result).value)

    if (successfulResponses.length === 0) {
      throw new Error('No successful responses from any hosts')
    }

    // Process the successful responses
    if (successfulResponses[0].type === 'freeform') {
      // Return the first freeform response
      return successfulResponses[0]
    } else {
      // Aggregate outputs from all successful responses
      const outputs = new Map<string, { beef: number[], outputIndex: number }>()
      for (const response of successfulResponses) {
        if (response.type !== 'output-list') {
          continue
        }
        try {
          for (const output of response.outputs) {
            try {
              const key = `${Transaction.fromBEEF(output.beef).id('hex')}.${output.outputIndex}`
              outputs.set(key, output)
            } catch (e) {
              continue
            }
          }
        } catch (e) {
          continue
        }
      }
      return {
        type: 'output-list',
        outputs: Array.from(outputs.values())
      }
    }
  }

  /**
     * Returns a list of competent hosts for a given lookup service.
     * @param service Service for which competent hosts are to be returned
     * @returns Array of hosts competent for resolving queries
     */
  private async findCompetentHosts(service: string): Promise<string[]> {
    const query: LookupQuestion = {
      service: 'ls_slap',
      query: {
        service
      }
    }

    // Use Promise.allSettled to handle individual SLAP tracker failures
    const trackerResponses = await Promise.allSettled(
      this.slapTrackers.map(async tracker => await this.facilitator.lookup(tracker, query))
    )

    const hosts = new Set<string>()

    for (const result of trackerResponses) {
      if (result.status === 'fulfilled') {
        const answer = result.value
        if (answer.type !== 'output-list') {
          // Log invalid response and continue
          continue
        }
        for (const output of answer.outputs) {
          try {
            const tx = Transaction.fromBEEF(output.beef)
            const script = tx.outputs[output.outputIndex].lockingScript
            const parsed = OverlayAdminTokenTemplate.decode(script)
            if (parsed.topicOrService !== service || parsed.protocol !== 'SLAP') {
              // Invalid advertisement, skip
              continue
            }
            hosts.add(parsed.domain)
          } catch (e) {
            // Invalid output, skip
            continue
          }
        }
      } else {
        // Log tracker failure and continue
        continue
      }
    }

    return [...hosts]
  }
}
