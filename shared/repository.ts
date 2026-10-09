import { z } from 'zod';

export const repositoryUrlSchema = z
  .string()
  .max(500)
  .refine(value => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        url.hostname === 'github.com' &&
        !url.port &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(url.pathname) &&
        !url.pathname.endsWith('.git')
      );
    } catch {
      return false;
    }
  }, 'Use a GitHub repository URL such as https://github.com/owner/repository.');
