<script lang="ts">
	import { tr, uiText, uiFormat } from '../i18n';

	import InlineChoice from '../controls/InlineChoice.svelte';
	import { ArrowUp, ArrowDown, Check, Play } from '@lucide/svelte';
	import sampleArtwork from '../player/tidal-memory.webp';
	import type { Session } from '../connection';
	import {
		defaultInterface,
		destinations,
		interfacePreferences,
		setInterface,
		readStartScreen,
		saveStartScreen,
		defaultMiniPlayer,
		miniButtons,
		miniText,
		readMiniPlayer,
		saveMiniPlayer,
		maxTabs,
		type MiniButton,
		type MiniPlayerPreferences,
		type Destination,
		type StartScreen,
		type InterfacePreferences
	} from './interface';
	let {
		offline = false,
		session,
		section
	}: {
		offline?: boolean;
		session: Session | null;
		section: 'style' | 'navigation' | 'mini';
	} = $props();
	let opening = $derived(session ? readStartScreen(session) : 'automatic');
	let mini = $derived(readMiniPlayer(session)),
		miniIssue = $state('');
	const sides = ['before', 'after'] as const;
	function changeMini(changes: Partial<MiniPlayerPreferences>) {
		if (!session?.userId) return;
		const next = { ...mini, ...changes };
		try {
			saveMiniPlayer(session, next);
			mini = next;
			miniIssue = '';
		} catch {
			miniIssue = 'Could not save the mini-player settings on this device.';
		}
	}
	function placeButton(side: 'before' | 'after', action: MiniButton) {
		const other = side === 'before' ? 'after' : 'before';
		changeMini(
			action !== 'none' && mini[other] === action
				? { [side]: action, [other]: mini[side] }
				: { [side]: action }
		);
	}
	let saveIssue = $state('');
	function changeStart(value: StartScreen) {
		if (!session) return;
		try {
			saveStartScreen(session, value);
			opening = value;
			saveIssue = '';
		} catch {
			saveIssue = 'Could not save the start screen on this device.';
		}
	}
	const options = $derived(destinations.filter((d) => offline || d.id !== 'offline'));
	const visible = $derived(
		$interfacePreferences.tabs.filter((id) => options.some((o) => o.id === id))
	);
	const ordered = $derived([
		...visible,
		...options.map((d) => d.id).filter((id) => !visible.includes(id))
	]);
	function toggle(id: Destination) {
		setInterface({
			tabs: visible.includes(id) ? visible.filter((t) => t !== id) : [...visible, id]
		});
	}
	function move(i: number, direction: number) {
		const tabs = [...visible],
			next = i + direction;
		if (next < 0 || next >= tabs.length) return;
		[tabs[i], tabs[next]] = [tabs[next], tabs[i]];
		setInterface({ tabs });
	}
	const surfaceNames = { solid: 'Solid Theme Color', glass: 'Glass', blur: 'Blur' } as const;
	const surfaces = Object.keys(surfaceNames) as InterfacePreferences['surface'][];
</script>

<div class="settings-stack">
	{#if section === 'style'}
		<h2 id="interface-material">{uiText('Button and panel style')}</h2>
		<div class="materials" role="group" aria-label={uiText('Surface style')}>
			{#each surfaces as style (style)}<button
					class="material-choice"
					aria-label={uiText(surfaceNames[style])}
					aria-pressed={$interfacePreferences.surface === style}
					onclick={() => setInterface({ surface: style })}
				>
					<span class="art-preview" aria-hidden="true" data-material={style}>
						<img src={sampleArtwork} alt="" />
						<span class="sample-panel" data-surface="panel">
							<Play size={13} fill="currentColor" /><span class="sample-lines"></span>
						</span>
						{#if $interfacePreferences.surface === style}<span class="check"
								><Check size={13} /></span
							>{/if}
					</span>
					<span class="material-name">{uiText(surfaceNames[style])}</span>
				</button>{/each}
		</div>
		{#if $interfacePreferences.surface === 'blur'}<label class="strength"
				><span>{uiText('Blur strength')} <output>{$interfacePreferences.blur} px</output></span
				><input
					aria-label={uiText('Blur strength')}
					type="range"
					min="0"
					max="24"
					step="1"
					value={$interfacePreferences.blur}
					oninput={(e) => setInterface({ blur: e.currentTarget.valueAsNumber })}
				/></label
			>{/if}
		<label class="settings-panel" data-surface="panel" id="interface-motion"
			>{uiText('Screen transitions')}<InlineChoice
				selected={$interfacePreferences.motion}
				label={uiText('Screen transitions')}
				><select
					value={$interfacePreferences.motion}
					onchange={(e) =>
						setInterface({ motion: e.currentTarget.value as InterfacePreferences['motion'] })}
					><option value="off">{uiText('Off')}</option><option value="quick"
						>{uiText('Quick')}</option
					><option value="gentle">{uiText('Gentle')}</option></select
				></InlineChoice
			></label
		>
		<button
			class="secondary"
			onclick={() => {
				const { surface, blur, motion } = defaultInterface;
				setInterface({ surface, blur, motion });
			}}>{tr('Restore style defaults', 'スタイルを初期設定に戻す')}</button
		>
	{:else if section === 'navigation'}
		{#if session?.userId}
			<label id="interface-start"
				>{uiText('Start screen')}
				<InlineChoice selected={opening}
					><select
						value={opening}
						onchange={(e) => changeStart(e.currentTarget.value as StartScreen)}
					>
						<option value="automatic">{uiText('Automatic')}</option>
						<option value="home">{uiText('Home')}</option>
						<option value="library">{uiText('Library')}</option>
						<option value="player">{uiText('Now Playing')}</option>
					</select></InlineChoice
				>
			</label>
			{#if opening === 'automatic'}<p>
					{uiText('Open Home when connected and Offline music when offline.')}
				</p>
			{:else if opening === 'player'}<p>
					{uiText('Open your saved queue. An empty queue opens Library.')}
				</p>{/if}
			{#if saveIssue}<p role="alert">{saveIssue}</p>{/if}
		{/if}
		<h2 id="interface-navigation">{uiText('Navigation bar')}</h2>
		<div
			class="settings-tabs"
			data-surface="panel"
			role="group"
			aria-label={uiText('Navigation bar position')}
		>
			{#each ['docked', 'floating'] as bar (bar)}<button
					aria-pressed={$interfacePreferences.bar === bar}
					onclick={() => setInterface({ bar: bar === 'floating' ? 'floating' : 'docked' })}
					>{bar === 'docked' ? uiText('Docked') : uiText('Floating')}</button
				>{/each}
		</div>
		<p>
			{uiFormat(
				'Pin up to {count} destinations. The Settings menu includes navigation shortcuts.',
				{
					count: maxTabs
				}
			)}
		</p>
		<div class="choices" data-surface="panel">
			{#each ordered as id, i (id)}
				{@const opt = options.find((d) => d.id === id)!}
				<div class="row">
					<label class="pick"
						><input
							type="checkbox"
							checked={visible.includes(id)}
							disabled={!visible.includes(id) && visible.length >= maxTabs}
							onchange={() => toggle(id)}
						/><opt.icon size={17} />{uiText(opt.label)}</label
					>
					{#if visible.includes(id)}<button
							class="order"
							aria-label={uiFormat('Move {name} earlier', { name: uiText(opt.label) })}
							disabled={i === 0}
							onclick={() => move(i, -1)}><ArrowUp size={17} /></button
						><button
							class="order"
							aria-label={uiFormat('Move {name} later', { name: uiText(opt.label) })}
							disabled={i === visible.length - 1}
							onclick={() => move(i, 1)}><ArrowDown size={17} /></button
						>{/if}
				</div>
			{/each}
		</div>
		<button
			class="secondary"
			onclick={() => {
				const { bar, tabs } = defaultInterface;
				setInterface({ bar, tabs });
				changeStart('automatic');
			}}>{tr('Restore navigation defaults', 'ナビゲーションを初期設定に戻す')}</button
		>
	{:else if session?.userId}
		<div
			class="mini-rows"
			data-surface="panel"
			role="group"
			id="mini-player-settings"
			aria-label={uiText('Mini-player')}
		>
			<label class="mini-row"
				><span>{uiText('Show cover artwork')}</span><input
					type="checkbox"
					checked={mini.artwork}
					onchange={(e) => changeMini({ artwork: e.currentTarget.checked })}
				/></label
			>
			<label class="mini-row"
				><span>{uiText('Secondary text')}</span><InlineChoice selected={mini.secondary}
					><select
						value={mini.secondary}
						onchange={(e) =>
							changeMini({
								secondary: e.currentTarget.value as MiniPlayerPreferences['secondary']
							})}
					>
						{#each Object.entries(miniText) as [value, label] (value)}<option {value}
								>{uiText(label)}</option
							>{/each}
					</select></InlineChoice
				></label
			>
			<label class="mini-row"
				><span>{uiText('Show track progress')}</span><input
					type="checkbox"
					checked={mini.progress}
					onchange={(e) => changeMini({ progress: e.currentTarget.checked })}
				/></label
			>
			{#each sides as side (side)}
				<label class="mini-row"
					><span
						>{side === 'before' ? uiText('Before Play/Pause') : uiText('After Play/Pause')}</span
					><InlineChoice selected={mini[side]}
						><select
							value={mini[side]}
							onchange={(e) => placeButton(side, e.currentTarget.value as MiniButton)}
						>
							{#each Object.entries(miniButtons) as [value, label] (value)}<option {value}
									>{uiText(label)}</option
								>{/each}
						</select></InlineChoice
					></label
				>
			{/each}
		</div>
		{#if miniIssue}<p role="alert">{miniIssue}</p>{/if}
		<button class="secondary" onclick={() => changeMini(defaultMiniPlayer)}
			>{tr('Restore mini-player defaults', 'ミニプレーヤーを初期設定に戻す')}</button
		>
	{/if}
</div>

<style>
	.mini-rows {
		border: 1px solid var(--line);
		border-radius: var(--radius);
		overflow: hidden;
	}
	.mini-rows .mini-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.55rem;
		min-height: 48px;
		padding: 0.25rem 0.65rem;
	}
	.mini-rows .mini-row:has(:global([aria-expanded='true'])) {
		align-items: flex-start;
	}
	.mini-row:has(:global([aria-expanded='true'])) > span {
		padding-top: 0.65rem;
	}
	.mini-row + .mini-row {
		border-top: 1px solid var(--line);
	}
	.mini-row input {
		width: 18px;
		height: 18px;
		accent-color: var(--accent);
		flex: none;
	}
	.mini-row :global(.inline-choice) {
		min-width: 0;
		max-width: 50%;
		width: auto;
	}
	p,
	output {
		color: var(--muted);
	}
	label:not(.pick) {
		display: grid;
		gap: 0.35rem;
	}
	.materials {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0.5rem;
	}
	.material-choice {
		display: grid;
		align-content: start;
		text-align: start;
		min-width: 0;
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		overflow: hidden;
	}
	.material-choice[aria-pressed='true'] {
		border-color: var(--dn-focus);
		box-shadow: 0 0 0 1px var(--dn-focus);
	}
	.art-preview {
		position: relative;
		display: grid;
		align-items: center;
		height: 4.5rem;
		isolation: isolate;
		padding: 0.35rem;
	}
	.art-preview img {
		position: absolute;
		inset: 0;
		z-index: -1;
		width: 100%;
		height: 100%;
		object-fit: cover;
		object-position: 50% 42%;
	}
	.sample-panel {
		display: flex;
		gap: 0.3rem;
		align-items: center;
		height: 1.9rem;
		padding-inline: 0.4rem;
		border-radius: max(3px, calc(var(--radius) * 0.55));
	}
	.sample-lines {
		display: grid;
		gap: 3px;
		width: 55%;
	}
	.sample-lines::before,
	.sample-lines::after {
		content: '';
		height: 2px;
		background: currentColor;
		border-radius: 99px;
	}
	.sample-lines::after {
		width: 65%;
		opacity: 0.55;
	}
	.check {
		position: absolute;
		inset-block-start: 0.25rem;
		inset-inline-end: 0.25rem;
		display: grid;
		width: 1.15rem;
		height: 1.15rem;
		place-items: center;
		border-radius: 50%;
		color: var(--dn-action-content);
		background: var(--dn-action);
	}
	.material-name {
		padding: 0.45rem;
		font-size: 0.82rem;
		font-weight: 650;
		line-height: 1.2;
	}
	.strength span {
		display: flex;
		justify-content: space-between;
	}
	.strength input {
		width: 100%;
	}
	.choices {
		overflow: hidden;
		border: 1px solid var(--line);
		border-radius: var(--radius);
	}
	.row {
		display: flex;
		align-items: center;
		padding: 0 0.4rem;
	}
	.row + .row {
		border-top: 1px solid var(--line);
	}
	.pick {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 0.6rem;
		min-height: 48px;
	}
	.pick input {
		width: 18px;
		height: 18px;
		accent-color: var(--accent);
	}
	.order {
		min-width: 44px;
		min-height: 44px;
	}
	button.secondary {
		justify-self: start;
	}
</style>
