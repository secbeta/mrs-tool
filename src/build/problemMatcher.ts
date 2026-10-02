import { GCC_PROBLEM_OWNER } from '../constants';

/**
 * gcc 8/12 diagnostic matcher, contributed in package.json
 * (`contributes.problemMatchers`) and attached to build tasks by name:
 * `file.c:12:3: error: message`.
 */
export const gccProblemMatcher: string = GCC_PROBLEM_OWNER;
