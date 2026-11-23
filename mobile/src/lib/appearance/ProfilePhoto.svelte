<script lang="ts">
	import { onDestroy } from 'svelte';
	import { UserRound } from '@lucide/svelte';
	import type { components } from '../../../../frontend/src/lib/api/v3/openapi';
	import { getArtwork, postJson, type Session } from '../connection';
	import { errorMessage, path } from '../catalog/catalog';
	import { tr } from '../i18n';

	type S = components['schemas'];
	let {
		session,
		profile,
		onupdate
	}: {
		session: Session;
		profile: S['ProfileResponse'];
		onupdate: (url: string) => void;
	} = $props();
	let input: HTMLInputElement;
	let image = $state(''),
		warning = $state(''),
		message = $state(''),
		saving = $state(false);
	let loadError = $state(''),
		retry = $state(0);
	const alive = new AbortController();
	onDestroy(() => alive.abort());
	$effect(() => {
		const account = session;
		const version = profile.avatar_url;
		void retry;
		image = loadError = '';
		if (!version) return;
		const controller = new AbortController();
		// Fetch only the signed-in profile's avatar from its DN server.
		const url = path(
			'/api/v3/users/{id}/avatar',
			{ id: profile.id },
			{
				v: new URLSearchParams(version.split('?')[1]).get('v') ?? undefined
			}
		);
		void getArtwork(account, url, controller.signal).then(
			(result) => {
				if (!controller.signal.aborted) image = result;
			},
			(err) => {
				if (!controller.signal.aborted) loadError = errorMessage(err);
			}
		);
		return () => controller.abort();
	});

	async function upload(file?: File) {
		if (!file || saving) return;
		warning = message = '';
		if (
			!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type) ||
			!file.size ||
			file.size > 5 * 1024 * 1024
		) {
			warning = tr(
				'Choose a JPEG, PNG, WebP or GIF image up to 5 MB.',
				'5 MB以下のJPEG、PNG、WebP、GIF画像を選択してください。'
			);
			return;
		}
		saving = true;
		try {
			const encoded = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result).split(',')[1]);
				reader.onerror = () =>
					reject(Error(tr('Could not read this image.', 'この画像を読み込めませんでした。')));
				reader.readAsDataURL(file);
			});
			alive.signal.throwIfAborted();
			const user = await postJson<S['UserResponse']>(
				session,
				path('/api/v3/me/avatar'),
				{
					content_type: file.type,
					image_base64: encoded
				} satisfies S['AvatarUploadBody'],
				alive.signal
			);
			if (!alive.signal.aborted && user.avatar_url) {
				onupdate(user.avatar_url);
				message = tr('Profile photo saved.', 'プロフィール写真を保存しました。');
			}
		} catch (cause) {
			if (!alive.signal.aborted) warning = errorMessage(cause);
		} finally {
			saving = false;
		}
	}
</script>

<div class="photo-row">
	{#if image}<img src={image} alt={tr('Profile photo', 'プロフィール写真')} />{:else}<UserRound
			size={40}
			aria-hidden="true"
		/>{/if}
	<input
		hidden
		type="file"
		accept="image/jpeg,image/png,image/webp,image/gif"
		bind:this={input}
		onchange={(e) => {
			const file = e.currentTarget.files?.[0];
			e.currentTarget.value = '';
			void upload(file);
		}}
	/>
	<button class="secondary" type="button" disabled={saving} onclick={() => input.click()}
		>{tr('Change profile photo', 'プロフィール写真を変更')}</button
	>
</div>
{#if loadError}<p role="alert">
		{loadError} <button class="text-button" onclick={() => retry++}>{tr('Retry', '再試行')}</button>
	</p>{/if}
{#if warning}<p role="alert">{warning}</p>{/if}
{#if message}<p role="status">{message}</p>{/if}

<style>
	.photo-row {
		display: flex;
		align-items: center;
		gap: var(--gap);
	}
	img {
		width: 3rem;
		height: 3rem;
		object-fit: cover;
		border-radius: 50%;
	}
</style>
