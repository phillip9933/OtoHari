package app.droppedneedle.mobile;

import androidx.media3.common.MediaItem;
import androidx.media3.common.Player;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Set;
import org.json.JSONArray;

/** Tracks occurrences by their local tag, since two queue entries can point at the same recording. */
@androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
final class QueueOrder {
    private ArrayList<MediaItem> original;
    private final Set<Object> upNext = Collections.newSetFromMap(new IdentityHashMap<>());
    // A listener may deliberately insert a track that a later DN page also contains.
    // Keep these occurrences out of DN's pagination counts, even after they have played.
    private final Set<Object> extras = Collections.newSetFromMap(new IdentityHashMap<>());

    void reset() {
        clear();
        upNext.clear();
        extras.clear();
    }

    void mark(List<MediaItem> entries) {
        for (MediaItem entry : entries) upNext.add(key(entry));
    }

    void markExtras(List<MediaItem> entries) {
        for (MediaItem entry : entries) extras.add(key(entry));
    }

    int extraCount() { return extras.size(); }

    boolean isExtra(MediaItem entry) { return extras.contains(key(entry)); }

    JSONArray extraIndices(Player player) {
        JSONArray result = new JSONArray();
        if (!extras.isEmpty()) for (int i = 0; i < player.getMediaItemCount(); i++)
            if (isExtra(player.getMediaItemAt(i))) result.put(i);
        return result;
    }

    void restoreExtras(List<MediaItem> tracks, JSONArray indices) {
        extras.clear();
        if (indices == null) return;
        for (int i = 0; i < indices.length(); i++) {
            int index = indices.optInt(i, -1);
            if (index >= 0 && index < tracks.size()) extras.add(key(tracks.get(index)));
        }
    }

    int insertion(Player player, String placement) {
        if ("end".equals(placement)) return player.getMediaItemCount();
        int at = player.getCurrentMediaItemIndex() + 1;
        if ("upNext".equals(placement)) {
            for (int i = at; i < player.getMediaItemCount(); i++)
                if (upNext.contains(key(player.getMediaItemAt(i)))) at = i + 1;
        }
        return at;
    }

    boolean consume(Player player) {
        if (upNext.isEmpty()) return false;
        int before = upNext.size();
        for (int i = 0; i <= player.getCurrentMediaItemIndex() && i < player.getMediaItemCount(); i++)
            upNext.remove(key(player.getMediaItemAt(i)));
        return upNext.size() != before;
    }

    void moving(Player player, int from, int to) {
        if (from == to) return;
        Object entry = key(player.getMediaItemAt(from));
        if (to > player.getCurrentMediaItemIndex() && upNext.contains(key(player.getMediaItemAt(to))))
            upNext.add(entry);
        else upNext.remove(entry);
    }

    JSONArray pending(Player player) {
        JSONArray indices = new JSONArray();
        if (!upNext.isEmpty())
            for (int i = player.getCurrentMediaItemIndex() + 1; i < player.getMediaItemCount(); i++)
                if (upNext.contains(key(player.getMediaItemAt(i)))) indices.put(i);
        return indices;
    }

    void restorePending(List<MediaItem> tracks, int current, JSONArray indices) {
        upNext.clear();
        if (indices == null) return;
        for (int i = 0; i < indices.length(); i++) {
            int index = indices.optInt(i, -1);
            if (index > current && index < tracks.size()) upNext.add(key(tracks.get(index)));
        }
    }

    boolean shuffled() {
        return original != null;
    }
    void clear() {
        original = null;
    }

    private static Object key(MediaItem item) {
        return item.localConfiguration.tag;
    }

    private int originalIndex(MediaItem item) {
        Object tag = key(item);
        for (int i = 0; i < original.size(); i++)
            if (key(original.get(i)) == tag)
                return i;
        return -1;
    }

    void toggle(Player player, FreshShuffle.History history) {
        int current = player.getCurrentMediaItemIndex(), count = player.getMediaItemCount();
        ArrayList<MediaItem> priority = new ArrayList<>();
        ArrayList<MediaItem> rest = new ArrayList<>();
        for (int i = current + 1; i < count; i++) {
            MediaItem entry = player.getMediaItemAt(i);
            (upNext.contains(key(entry)) ? priority : rest).add(entry);
        }
        if (original != null) {
            int normal = originalIndex(player.getCurrentMediaItem());
            if (normal >= 0) {
                // Retain the playing occurrence on the Media3 timeline, including its decoder and seek position.
                ArrayList<MediaItem> before = new ArrayList<>();
                for (int i = 0; i < original.size(); i++) {
                    MediaItem entry = original.get(i);
                    if (i == normal || upNext.contains(key(entry))) continue;
                    (i < normal ? before : priority).add(entry);
                }
                player.replaceMediaItems(current + 1, count, priority);
                player.replaceMediaItems(0, current, before);
            }
            clear();
        } else if (rest.size() >= 2) {
            original = new ArrayList<>();
            for (int i = 0; i < count; i++) original.add(player.getMediaItemAt(i));
            FreshShuffle.draw(rest, item -> item.mediaId, history);
            priority.addAll(rest);
            player.replaceMediaItems(current + 1, count, priority);
        }
    }

    void insert(List<MediaItem> added, MediaItem after) {
        if (original != null)
            original.addAll(after == null ? original.size() : originalIndex(after) + 1, added);
    }

    void remove(Player player, int from, int to) {
        if (from == to) return;
        IdentityHashMap<Object, Boolean> removed = new IdentityHashMap<>();
        for (int i = from; i < to; i++) removed.put(key(player.getMediaItemAt(i)), true);
        upNext.removeAll(removed.keySet());
        extras.removeAll(removed.keySet());
        if (original != null) original.removeIf(item -> removed.containsKey(key(item)));
    }

    JSONArray save(Player player) {
        if (original == null || original.size() != player.getMediaItemCount())
            return null;
        IdentityHashMap<Object, Integer> ranks = new IdentityHashMap<>();
        for (int i = 0; i < original.size(); i++) ranks.put(key(original.get(i)), i);
        JSONArray saved = new JSONArray();
        for (int i = 0; i < original.size(); i++) {
            Integer rank = ranks.get(key(player.getMediaItemAt(i)));
            if (rank == null)
                return null;
            saved.put(rank.intValue());
        }
        return saved;
    }

    void restore(List<MediaItem> tracks, JSONArray ranks) {
        clear();
        if (ranks == null || ranks.length() != tracks.size())
            return;
        ArrayList<MediaItem> restored = new ArrayList<>(Collections.nCopies(tracks.size(), null));
        for (int i = 0; i < tracks.size(); i++) {
            int rank = ranks.optInt(i, -1);
            if (rank < 0 || rank >= tracks.size() || restored.set(rank, tracks.get(i)) != null)
                return;
        }
        original = restored;
    }
}
