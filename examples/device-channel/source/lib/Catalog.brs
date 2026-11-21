' Generic fixture catalog: 2 rows x 5 items of made-up titles. No real content.
function BTDev_catalog() as object
    items = []
    names = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliet"]
    for i = 0 to names.count() - 1
        items.push({
            id: "item-" + (i + 1).toStr(),
            title: "Title " + names[i],
            desc: "Fixture description for " + names[i] + ". Not a real title.",
            row: Int(i / 5),
            durationSec: 600 + i * 95
        })
    end for
    return items
end function

function BTDev_findItem(id as string) as dynamic
    for each it in BTDev_catalog()
        if it.id = id then return it
    end for
    return invalid
end function

function BTDev_formatDuration(sec as integer) as string
    mins = Int(sec / 60)
    secs = sec - mins * 60
    pad = ""
    if secs < 10 then pad = "0"
    return mins.toStr() + ":" + pad + secs.toStr()
end function

' Injectable clock: clock.hour() -> 0..23 (swap in a fake in specs).
function BTDev_greet(clock as object) as string
    h = clock.hour()
    if h < 12 then return "Good morning"
    if h < 18 then return "Good afternoon"
    return "Good evening"
end function
