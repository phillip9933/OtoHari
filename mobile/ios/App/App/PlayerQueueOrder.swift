import Foundation

/// Marks individual queue occurrences, including when a recording appears more than once.
struct PlayerQueueOrder {
    struct Saved: Codable {
        let original: [Int]?
        let priority: [Int]
        let extras: [Int]
    }
    var original: [UUID]?
    var priority = Set<UUID>()
    var extras = Set<UUID>()

    func insertion(_ placement: String, in keys: [UUID], current: Int) -> Int {
        if placement == "end" { return keys.count }
        let next = current + 1
        if placement == "upNext", let last = keys.indices.dropFirst(next).last(where: { priority.contains(keys[$0]) }) {
            return last + 1
        }
        return next
    }
    mutating func inserted(_ added: [UUID], after: UUID?, placement: String) {
        extras.formUnion(added)
        if placement != "end" { priority.formUnion(added) }
        if var order = original {
            let target = after.flatMap { order.firstIndex(of: $0) }.map { $0 + 1 } ?? order.count
            order.insert(contentsOf: added, at: target)
            original = order
        }
    }
    mutating func remove(_ keys: Set<UUID>) {
        priority.subtract(keys); extras.subtract(keys)
        original?.removeAll(where: keys.contains)
    }
    mutating func toggle(_ keys: [UUID], current: Int, ids: [UUID: String], excluded: String?, hash: ([String]) -> String) -> [UUID] {
        guard keys.indices.contains(current) else { return keys }
        let future = keys.dropFirst(current + 1)
        let priorityKeys = future.filter(priority.contains)
        if let original, let at = original.firstIndex(of: keys[current]) {
            self.original = nil
            return original[...at].filter { !priority.contains($0) } + priorityKeys + original[(at + 1)...].filter { !priority.contains($0) }
        }
        var pool = future.filter { !priority.contains($0) }
        guard Set(pool.compactMap { ids[$0] }).count > 1 else { return keys }
        original = keys
        let rejected = excluded ?? hash(pool.compactMap { ids[$0] })
        repeat { pool.shuffle() } while hash(pool.compactMap { ids[$0] }) == rejected
        return Array(keys[...current]) + priorityKeys + pool
    }
    func saved(_ keys: [UUID]) -> Saved {
        let indices = Dictionary(uniqueKeysWithValues: keys.enumerated().map { ($0.element, $0.offset) })
        return Saved(original: original?.compactMap { indices[$0] },
                     priority: keys.indices.filter { priority.contains(keys[$0]) },
                     extras: keys.indices.filter { extras.contains(keys[$0]) })
    }
    init() {}
    init(_ saved: Saved?, keys: [UUID], current: Int) {
        guard let saved else { return }
        if let order = saved.original, order.count == keys.count, Set(order) == Set(keys.indices) {
            original = order.map { keys[$0] }
        }
        priority = Set(saved.priority.filter { keys.indices.contains($0) && $0 > current }.map { keys[$0] })
        extras = Set(saved.extras.filter { keys.indices.contains($0) }.map { keys[$0] })
    }
}
