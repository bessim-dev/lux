/* ---------- FAVORITES ---------- */
import { allTasks, canSee, visibleProjects } from '../core/store.js';
import { empty } from '../ui/helpers.js';
import { miniRow } from '../components/task-list.js';
import { projectCard } from './projects.js';

export function pageFavorites() {
  const ps = visibleProjects().filter(p => p.fav && canSee(p));
  const ts = allTasks().filter(t => t.fav);
  return `<div class="page wide">
    <div class="ph"><div><h1>Favorites</h1><p>Projects and tasks you've starred for quick access.</p></div></div>
    ${
      !ps.length && !ts.length
        ? `<div class="panel">${empty('star', 'No favorites yet', 'Star a project or task to pin it here.', `<button class="btn btn-secondary btn-sm" data-a="go" data-r="projects">Browse projects</button>`)}</div>`
        : `
    <h2 class="sec" style="margin-bottom:10px">Projects <span class="faint" style="font-weight:500">${ps.length}</span></h2>
    ${ps.length ? `<div class="pgrid" style="margin-bottom:28px">${ps.map(projectCard).join('')}</div>` : '<p class="faint" style="margin-bottom:28px">No favorite projects.</p>'}
    <h2 class="sec" style="margin-bottom:6px">Tasks <span class="faint" style="font-weight:500">${ts.length}</span></h2>
    ${ts.length ? `<div class="panel" style="overflow:hidden">${ts.map(t => miniRow(t)).join('')}</div>` : '<p class="faint">Open a task and click the star to add it here.</p>'}`
    }
  </div>`;
}
