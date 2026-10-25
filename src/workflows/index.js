import { codeReviewWorkflow } from './code-review.js'
import { parallelDemoWorkflow } from './parallel-demo.js'

export const workflows = {
  'code-review': codeReviewWorkflow,
  'parallel-demo': parallelDemoWorkflow,
}

export { codeReviewWorkflow, parallelDemoWorkflow }
