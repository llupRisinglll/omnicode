path = "/mnt/data/KSProjects/NanoCollective/nanocoder/source/components/model-selector.tsx"
with open(path, "r", encoding="utf-8") as f:
    lines = f.readlines()

# Find and fix the AutoContextLabel wrapper - remove Text wrapper
new_lines = []
i = 0
while i < len(lines):
    if i < len(lines) - 1 and '<Text' in lines[i] and '<AutoContextLabel' in lines[i+1]:
        # Skip this Text opening and find matching </Text>
        # The pattern is: <Text ...>, <AutoContextLabel ... />, </Text>
        # Skip the Text opening (i), and the </Text> (i+5)
        # But keep the AutoContextLabel and its props (i+1 through i+4)
        j = i + 1
        while j < len(lines) and '</Text>' not in lines[j]:
            j += 1
        # j is the index of </Text>
        # Keep lines i+1 through j-1 (the AutoContextLabel and props)
        for k in range(i+1, j):
            new_lines.append(lines[k])
        i = j + 1
        continue
    new_lines.append(lines[i])
    i += 1

with open(path, "w", encoding="utf-8") as f:
    f.writelines(new_lines)
print("fixed")