/**
 * LruCache - 轻量级 LRU 缓存
 *
 * 利用 Map 的插入顺序特性实现 O(1) 的 get/set/evict。
 * 当容量超限时淘汰最旧（最久未访问）的条目。
 */
export class LruCache<K, V> {
    private cache: Map<K, V>;
    private readonly maxSize: number;

    constructor(maxSize: number) {
        if (maxSize < 1) {
            throw new Error(`LruCache maxSize must be >= 1, received: ${maxSize}`);
        }
        this.cache = new Map();
        this.maxSize = maxSize;
    }

    /**
     * 获取缓存值
     *
     * 命中时将条目提升为"最新"，避免被淘汰
     */
    get(key: K): V | undefined {
        const value = this.cache.get(key);
        if (value !== undefined) {
            // 删除后重新 set，移至 Map 末尾（最新位置）
            this.cache.delete(key);
            this.cache.set(key, value);
        }
        return value;
    }

    /**
     * 设置缓存值
     *
     * 如果 key 已存在则更新并提升为最新；
     * 如果容量超限则淘汰 Map 中第一个条目（最旧）。
     */
    set(key: K, value: V): void {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxSize) {
            // 淘汰最旧条目（Map 的第一个 key）
            const firstKey = this.cache.keys().next().value;
            if (firstKey !== undefined) {
                this.cache.delete(firstKey);
            }
        }
        this.cache.set(key, value);
    }

    /** 检查 key 是否存在 */
    has(key: K): boolean {
        return this.cache.has(key);
    }

    /** 删除指定 key */
    delete(key: K): boolean {
        return this.cache.delete(key);
    }

    /** 清空所有缓存 */
    clear(): void {
        this.cache.clear();
    }

    /** 当前缓存条目数 */
    get size(): number {
        return this.cache.size;
    }

    /** Return cached values from oldest to newest without changing LRU order. */
    values(): V[] {
        return Array.from(this.cache.values());
    }

    /**
     * 按条件批量删除
     *
     * @returns 删除的条目数量
     */
    deleteWhere(predicate: (key: K, value: V) => boolean): number {
        let count = 0;
        for (const [key, value] of this.cache) {
            if (predicate(key, value)) {
                this.cache.delete(key);
                count++;
            }
        }
        return count;
    }
}
