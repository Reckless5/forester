// Small modal dialogs: action menus, pick-from-a-list, text input.
// Each returns a promise that resolves with the choice, or undefined when cancelled.

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface Choice {
  id: string;
  label: string;
  sub?: string;
  danger?: boolean;
}

function open<T>(inner: string, wire: (box: HTMLElement, done: (v: T | undefined) => void) => void): Promise<T | undefined> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'dialog-backdrop';
    backdrop.innerHTML = `<div class="dialog" role="dialog" aria-modal="true">${inner}</div>`;
    const box = backdrop.firstElementChild as HTMLElement;
    const done = (v: T | undefined) => {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') done(undefined);
    };
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop || (e.target as HTMLElement).closest('[data-dlg=cancel]')) done(undefined);
    });
    document.body.appendChild(backdrop);
    wire(box, done);
  });
}

/** A list of actions, e.g. the ⋯ menu of a parcel. */
export function actionSheet(title: string, actions: Choice[]) {
  return open<string>(
    `<h3>${esc(title)}</h3>
     <ul class="dialog-list">${actions
       .map((a) => `<li><button type="button" data-id="${esc(a.id)}" class="${a.danger ? 'danger' : ''}">${esc(a.label)}</button></li>`)
       .join('')}</ul>
     <button type="button" class="dialog-cancel" data-dlg="cancel">Abbrechen</button>`,
    (box, done) =>
      box.addEventListener('click', (e) => {
        const id = (e.target as HTMLElement).closest<HTMLElement>('[data-id]')?.dataset.id;
        if (id) done(id);
      }),
  );
}

/** Pick one item from a list, optionally with a search field. */
export function choose(title: string, items: Choice[], opts: { search?: boolean; hint?: string; empty?: string } = {}) {
  return open<string>(
    `<h3>${esc(title)}</h3>
     ${opts.hint ? `<p class="fineprint">${esc(opts.hint)}</p>` : ''}
     ${opts.search ? `<input type="search" class="dialog-search" placeholder="Suchen…" aria-label="Suchen" />` : ''}
     <ul class="dialog-list"></ul>
     <button type="button" class="dialog-cancel" data-dlg="cancel">Abbrechen</button>`,
    (box, done) => {
      const ul = box.querySelector('ul')!;
      const input = box.querySelector<HTMLInputElement>('.dialog-search');
      const render = () => {
        const q = input?.value.trim().toLowerCase() ?? '';
        const shown = items.filter((i) => !q || `${i.label} ${i.sub ?? ''}`.toLowerCase().includes(q));
        ul.innerHTML = shown.length
          ? shown
              .map(
                (i) => `<li><button type="button" data-id="${esc(i.id)}" class="${i.danger ? 'danger' : ''}">
                  <strong>${esc(i.label)}</strong>${i.sub ? `<span>${esc(i.sub)}</span>` : ''}</button></li>`,
              )
              .join('')
          : `<li class="empty">${esc(opts.empty ?? 'Nichts gefunden.')}</li>`;
      };
      render();
      input?.addEventListener('input', render);
      input?.focus();
      box.addEventListener('click', (e) => {
        const id = (e.target as HTMLElement).closest<HTMLElement>('[data-id]')?.dataset.id;
        if (id) done(id);
      });
    },
  );
}

/** Ask for a short text, e.g. a group name. */
export function askText(title: string, value = '', opts: { placeholder?: string; ok?: string } = {}) {
  return open<string>(
    `<h3>${esc(title)}</h3>
     <form class="form">
       <input type="text" maxlength="80" value="${esc(value)}" placeholder="${esc(opts.placeholder ?? '')}" required />
       <div class="sheet-actions">
         <button type="button" data-dlg="cancel">Abbrechen</button>
         <button type="submit" class="primary">${esc(opts.ok ?? 'OK')}</button>
       </div>
     </form>`,
    (box, done) => {
      const input = box.querySelector('input')!;
      input.focus();
      input.select();
      box.querySelector('form')!.addEventListener('submit', (e) => {
        e.preventDefault();
        const v = input.value.trim();
        if (v) done(v);
      });
    },
  );
}
