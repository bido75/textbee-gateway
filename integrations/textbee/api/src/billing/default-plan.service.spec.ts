import { getModelToken } from '@nestjs/mongoose'
import { Test } from '@nestjs/testing'
import { DefaultPlanService } from './default-plan.service'
import { Plan } from './schemas/plan.schema'

describe('DefaultPlanService', () => {
  const updateOne = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
    delete process.env.TEXTBEE_SELF_HOSTED
    updateOne.mockResolvedValue({ upsertedCount: 1 })
  })

  afterEach(() => delete process.env.TEXTBEE_SELF_HOSTED)

  it('creates an unlimited free plan for self-hosted deployments', async () => {
    process.env.TEXTBEE_SELF_HOSTED = 'true'
    const module = await Test.createTestingModule({
      providers: [
        DefaultPlanService,
        { provide: getModelToken(Plan.name), useValue: { updateOne } },
      ],
    }).compile()

    await module.get(DefaultPlanService).onModuleInit()

    expect(updateOne).toHaveBeenCalledWith(
      { name: 'free' },
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({
          dailyLimit: -1,
          monthlyLimit: -1,
          bulkSendLimit: -1,
          deviceLimit: -1,
        }),
      }),
      { upsert: true },
    )
  })
})

